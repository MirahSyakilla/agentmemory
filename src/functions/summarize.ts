import type { ISdk } from "iii-sdk";
import type {
  CompressedObservation,
  SessionSummary,
  MemoryProvider,
  Session,
  ObservationType,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import {
  SUMMARY_SYSTEM,
  buildSummaryPrompt,
  REDUCE_SYSTEM,
  buildReducePrompt,
} from "../prompts/summary.js";
import { getXmlTag, getXmlChildren } from "../prompts/xml.js";
import { SummaryOutputSchema } from "../eval/schemas.js";
import { validateOutput } from "../eval/validator.js";
import { scoreSummary } from "../eval/quality.js";
import type { MetricsStore } from "../eval/metrics-store.js";
import { safeAudit } from "./audit.js";
import { logger } from "../logger.js";
import { getEnvVar } from "../config.js";

// Per-chunk observation budget when a session is too large to fit in one
// LLM call. Default ≈ 50k input tokens per chunk at ~110 tok/obs — fits
// comfortably in 128k-window models. Override via SUMMARIZE_CHUNK_SIZE.
const CHUNK_SIZE_DEFAULT = 400;
// Concurrent in-flight chunk calls. 6 keeps a 100-chunk session under
// iii's 180s function-invocation timeout at ~8s/call while staying
// inside generous-but-not-unlimited provider rate limits (well below
// OpenAI free tier's 500 RPM). High-throughput providers
// (Novita / DeepInfra / DeepSeek) typically allow 100+ concurrent — set
// SUMMARIZE_CHUNK_CONCURRENCY higher to cover ~1000+ chunk sessions.
const CHUNK_CONCURRENCY_DEFAULT = 6;
const MAX_CHUNKS_DEFAULT = 20;
const ADAPTIVE_MIN_CHUNK_SIZE_DEFAULT = 50;
// Bail on the merged summary if more than this fraction of chunks fail
// to parse — a half-blind narrative is worse than a clean error.
const MAX_SKIP_RATIO = 0.5;
const GENERIC_SUMMARY_TITLES = new Set([
  "session_start",
  "prompt_submit",
  "pre_tool_use",
  "post_tool_use",
  "post_tool_failure",
  "stop",
  "write_stdin",
  "update_plan",
  "get_goal",
]);

function getChunkSize(): number {
  const raw = getEnvVar("SUMMARIZE_CHUNK_SIZE");
  if (!raw) return CHUNK_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_SIZE_DEFAULT;
}

function getChunkConcurrency(): number {
  const raw = getEnvVar("SUMMARIZE_CHUNK_CONCURRENCY");
  if (!raw) return CHUNK_CONCURRENCY_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : CHUNK_CONCURRENCY_DEFAULT;
}

function getMaxChunks(): number {
  const raw = getEnvVar("SUMMARIZE_MAX_CHUNKS");
  if (!raw) return MAX_CHUNKS_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : MAX_CHUNKS_DEFAULT;
}

function getAdaptiveMinChunkSize(): number {
  const raw = getEnvVar("SUMMARIZE_ADAPTIVE_MIN_CHUNK_SIZE");
  if (!raw) return ADAPTIVE_MIN_CHUNK_SIZE_DEFAULT;
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : ADAPTIVE_MIN_CHUNK_SIZE_DEFAULT;
}

type PartialSummary = {
  summary: SessionSummary;
  obsRangeStart: number;
  obsRangeEnd: number;
};

// One chunk call with retry-once. Returns null when both attempts fail —
// whether by parse failure, provider 4xx (content rejected by upstream
// filters), or transient network/5xx errors that didn't recover on retry.
// All failure modes are equivalent at this layer: the chunk is unusable,
// skip it and let the caller decide via the skip-ratio bailout whether
// the overall summary is still trustworthy. Errors that affect every
// chunk (auth, model down) will trip the bailout naturally.
async function summarizeChunkWithRetry(
  provider: MemoryProvider,
  chunk: CompressedObservation[],
  sessionId: string,
  project: string,
  idx: number,
  total: number,
  rangeStart: number,
  minChunkSize: number,
): Promise<PartialSummary[]> {
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const xml = await provider.summarize(
        SUMMARY_SYSTEM,
        buildSummaryPrompt(chunk),
      );
      const parsed = parseSummaryXml(xml, sessionId, project, chunk.length);
      if (parsed) {
        return [{
          summary: parsed,
          obsRangeStart: rangeStart,
          obsRangeEnd: rangeStart + chunk.length - 1,
        }];
      }
      logger.warn("Summarize chunk parse failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        observations: chunk.length,
      });
    } catch (err) {
      logger.warn("Summarize chunk LLM call failed", {
        sessionId,
        chunk: `${idx + 1}/${total}`,
        attempt,
        observations: chunk.length,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  if (chunk.length <= minChunkSize) return [];

  const midpoint = Math.ceil(chunk.length / 2);
  logger.warn("Summarize chunk failed; retrying with smaller chunks", {
    sessionId,
    chunk: `${idx + 1}/${total}`,
    observations: chunk.length,
    nextChunkSizes: [midpoint, chunk.length - midpoint],
    minChunkSize,
  });
  const left = await summarizeChunkWithRetry(
    provider,
    chunk.slice(0, midpoint),
    sessionId,
    project,
    idx,
    total,
    rangeStart,
    minChunkSize,
  );
  const right = await summarizeChunkWithRetry(
    provider,
    chunk.slice(midpoint),
    sessionId,
    project,
    idx,
    total,
    rangeStart + midpoint,
    minChunkSize,
  );
  return [...left, ...right];
}

// Returns the final summary XML string. For sessions ≤ chunk size, this is
// a single LLM call (legacy behavior). For larger sessions, observations
// are split into chunks processed in parallel batches, each chunk retried
// once on parse failure, persistently-bad chunks skipped, and remaining
// partials merged via a reduce call.
async function produceSummaryXml(
  provider: MemoryProvider,
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
): Promise<{
  response: string;
  mode: "single" | "chunked";
  chunks: number;
  skipped?: number;
}> {
  const chunkSize = getChunkSize();
  if (compressed.length <= chunkSize) {
    const response = await provider.summarize(
      SUMMARY_SYSTEM,
      buildSummaryPrompt(compressed),
    );
    return { response, mode: "single", chunks: 1 };
  }

  const chunks: CompressedObservation[][] = [];
  for (let i = 0; i < compressed.length; i += chunkSize) {
    chunks.push(compressed.slice(i, i + chunkSize));
  }
  const concurrency = getChunkConcurrency();
  const minChunkSize = getAdaptiveMinChunkSize();
  logger.info("Summarize chunking session", {
    sessionId,
    chunks: chunks.length,
    chunkSize,
    concurrency,
    adaptiveMinChunkSize: minChunkSize,
    totalObservations: compressed.length,
  });

  // Sparse array preserves chunk → index mapping after parallel resolution,
  // so the reduce step sees partials in chronological order even when some
  // were skipped.
  const partialByIdx: Array<PartialSummary[]> = new Array(chunks.length)
    .fill(null)
    .map(() => []);
  for (let batchStart = 0; batchStart < chunks.length; batchStart += concurrency) {
    const batch = chunks.slice(batchStart, batchStart + concurrency);
    await Promise.all(
      batch.map(async (chunk, j) => {
        const idx = batchStart + j;
        partialByIdx[idx] = await summarizeChunkWithRetry(
          provider,
          chunk,
          sessionId,
          project,
          idx,
          chunks.length,
          idx * chunkSize + 1,
          minChunkSize,
        );
      }),
    );
  }

  const skipped = partialByIdx.filter((p) => p.length === 0).length;
  const partials = partialByIdx.flat();

  if (skipped > Math.floor(chunks.length * MAX_SKIP_RATIO)) {
    throw new Error(
      `too_many_chunks_skipped: ${skipped}/${chunks.length} chunks failed to parse after retry`,
    );
  }
  if (skipped > 0) {
    logger.warn("Summarize chunks partially skipped", {
      sessionId,
      skipped,
      total: chunks.length,
    });
  }

  const reduceInput = partials.map((p) => ({
    title: p.summary.title,
    narrative: p.summary.narrative,
    keyDecisions: p.summary.keyDecisions,
    filesModified: p.summary.filesModified,
    concepts: p.summary.concepts,
    obsRangeStart: p.obsRangeStart,
    obsRangeEnd: p.obsRangeEnd,
  }));
  const response = await provider.summarize(
    REDUCE_SYSTEM,
    buildReducePrompt(reduceInput),
  );
  return { response, mode: "chunked", chunks: chunks.length, skipped };
}

// #783: many LLMs (DeepSeek, GPT variants, some Anthropic responses)
// wrap structured XML in markdown code fences or add conversational
// text before/after. Strip those wrappers before the tag regex so a
// well-formed summary doesn't get silently dropped as parse_failed.
function stripXmlWrappers(raw: string): string {
  if (!raw) return "";
  let cleaned = raw.trim();
  // ```xml ... ``` or ``` ... ``` fences (anywhere in the payload).
  cleaned = cleaned.replace(/```\s*xml\s*\n?/gi, "");
  cleaned = cleaned.replace(/```/g, "");
  cleaned = cleaned.trim();
  // If preamble / postamble surrounds the XML root, peel it off.
  const rootMatch = cleaned.match(
    /(<[a-zA-Z_][a-zA-Z0-9_-]*>[\s\S]*<\/[a-zA-Z_][a-zA-Z0-9_-]*>)/,
  );
  if (rootMatch && rootMatch[1]) return rootMatch[1].trim();
  return cleaned;
}

function parseSummaryXml(
  xml: string,
  sessionId: string,
  project: string,
  obsCount: number,
): SessionSummary | null {
  const cleaned = stripXmlWrappers(xml);
  const title = getXmlTag(cleaned, "title");
  if (!title) return null;

  return {
    sessionId,
    project,
    createdAt: new Date().toISOString(),
    title,
    narrative: getXmlTag(cleaned, "narrative"),
    keyDecisions: getXmlChildren(cleaned, "decisions", "decision"),
    filesModified: getXmlChildren(cleaned, "files", "file"),
    concepts: getXmlChildren(cleaned, "concepts", "concept"),
    observationCount: obsCount,
  };
}

function trimText(value: string, maxLength: number): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) return normalized;
  return normalized.slice(0, Math.max(0, maxLength - 3)).trimEnd() + "...";
}

function rankItems(
  observations: CompressedObservation[],
  pick: (observation: CompressedObservation) => string[],
  opts: { limit: number; allow: (value: string) => boolean },
): string[] {
  const scores = new Map<string, number>();
  const casing = new Map<string, string>();
  for (const observation of observations) {
    const weight = Math.max(1, observation.importance || 1);
    for (const rawValue of pick(observation)) {
      const value = rawValue.trim();
      if (!value || !opts.allow(value)) continue;
      const key = value.toLowerCase();
      scores.set(key, (scores.get(key) || 0) + weight);
      if (!casing.has(key)) casing.set(key, value);
    }
  }
  return [...scores.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, opts.limit)
    .map(([key]) => casing.get(key) || key);
}

function fileAllowed(file: string): boolean {
  const trimmed = file.trim();
  if (!trimmed || trimmed.length > 240) return false;
  if (trimmed === "//") return false;
  if (trimmed.startsWith("http://") || trimmed.startsWith("https://")) return false;
  if (trimmed.startsWith("/abs/path/")) return false;
  if (trimmed.includes("/.ssh/")) return false;
  if (trimmed.includes("${")) return false;
  return true;
}

function conceptAllowed(concept: string): boolean {
  const trimmed = concept.trim().toLowerCase();
  if (trimmed.length < 3 || trimmed.length > 40) return false;
  if (trimmed === "json" || trimmed === "tool" || trimmed === "call") return false;
  return true;
}

function typeAllowed(type: ObservationType): boolean {
  return type !== "conversation" && type !== "other";
}

function formatList(items: string[], fallback: string): string {
  if (items.length === 0) return fallback;
  if (items.length === 1) return items[0];
  if (items.length === 2) return `${items[0]} and ${items[1]}`;
  return `${items[0]}, ${items[1]}, and ${items[2]}`;
}

function fileLabel(file: string): string {
  const withoutTrailing = file.replace(/\/+$/, "");
  const parts = withoutTrailing.split(/[\\/]/).filter(Boolean);
  if (parts.length === 0) return withoutTrailing;
  const short = parts.slice(-2).join("/");
  return trimText(short, 40);
}

function titleAllowed(title: string): boolean {
  const trimmed = title.trim();
  if (!trimmed) return false;
  if (GENERIC_SUMMARY_TITLES.has(trimmed.toLowerCase())) return false;
  return true;
}

function buildFallbackTitle(
  project: string,
  filesModified: string[],
  concepts: string[],
  activityTypes: string[],
): string {
  if (filesModified.length >= 2) {
    return trimText(
      `${fileLabel(filesModified[0])} and ${fileLabel(filesModified[1])} work in ${project}`,
      100,
    );
  }
  if (concepts.length >= 2) {
    return trimText(`${concepts[0]} and ${concepts[1]} work in ${project}`, 100);
  }
  if (filesModified.length === 1) {
    return trimText(`${fileLabel(filesModified[0])} updates in ${project}`, 100);
  }
  if (activityTypes.length > 0) {
    return trimText(`${activityTypes[0]} activity in ${project}`, 100);
  }
  return trimText(`${project} session summary`, 100);
}

export function buildDeterministicSummary(
  compressed: CompressedObservation[],
  sessionId: string,
  project: string,
  now = new Date().toISOString(),
): SessionSummary {
  const filesModified = rankItems(compressed, (observation) => observation.files || [], {
    limit: 20,
    allow: fileAllowed,
  });
  const concepts = rankItems(compressed, (observation) => observation.concepts || [], {
    limit: 16,
    allow: conceptAllowed,
  });
  const activityTypes = rankItems(
    compressed,
    (observation) => (typeAllowed(observation.type) ? [observation.type.replace(/_/g, " ")] : []),
    { limit: 6, allow: (value) => value.length > 0 },
  );
  const notableTitles = rankItems(
    compressed,
    (observation) => (titleAllowed(observation.title) ? [observation.title] : []),
    { limit: 6, allow: titleAllowed },
  );
  const title = buildFallbackTitle(project, filesModified, concepts, activityTypes);
  const narrative = trimText(
    [
      `Session captured ${compressed.length} observations in ${project}, touching ${filesModified.length || 0} frequently referenced files and ${concepts.length || 0} recurring concepts.`,
      `Most activity centered on ${formatList(filesModified.slice(0, 3).map(fileLabel), "the imported replay timeline")}.`,
      `Repeated themes included ${formatList(concepts.slice(0, 3), "general coding workflow")}.`,
      `Notable work surfaced around ${formatList(notableTitles.slice(0, 3), "high-importance observations")}.`,
    ].join(" "),
    1200,
  );
  const keyDecisions = [
    filesModified.length > 0
      ? `Prioritize investigation around ${formatList(filesModified.slice(0, 3).map(fileLabel), "the active files")}.`
      : "",
    concepts.length > 0
      ? `Keep follow-up context tied to ${formatList(concepts.slice(0, 3), "the dominant themes")}.`
      : "",
    notableTitles.length > 0
      ? `Use ${formatList(notableTitles.slice(0, 3), "the highest-signal observations")} as the main summary anchors.`
      : "",
  ]
    .map((value) => value.trim())
    .filter(Boolean)
    .slice(0, 8);

  return {
    sessionId,
    project,
    createdAt: now,
    title,
    narrative,
    keyDecisions,
    filesModified,
    concepts,
    observationCount: compressed.length,
  };
}

export function registerSummarizeFunction(
  sdk: ISdk,
  kv: StateKV,
  provider: MemoryProvider,
  metricsStore?: MetricsStore,
): void {
  const inFlight = new Map<string, Promise<unknown>>();

  sdk.registerFunction("mem::summarize", 
    async (data: { sessionId: string } | undefined) => {
      const startMs = Date.now();
      if (!data || typeof data.sessionId !== "string" || !data.sessionId.trim()) {
        return { success: false, error: "sessionId is required" };
      }
      const sessionId = data.sessionId.trim();
      const existing = inFlight.get(sessionId);
      if (existing) {
        logger.info("Summarize joined existing in-flight request", { sessionId });
        return existing;
      }

      const run = async () => {

      const session = await kv.get<Session>(KV.sessions, sessionId);
      if (!session) {
        logger.warn("Session not found for summarize", {
          sessionId,
        });
        return { success: false, error: "session_not_found" };
      }

      const observations = await kv.list<CompressedObservation>(
        KV.observations(sessionId),
      );
      const compressed = observations.filter((o) => o.title);
      const allowDeterministicFallback = session.tags?.includes("jsonl-import") === true;

      if (compressed.length === 0) {
        logger.info("No observations to summarize", {
          sessionId,
        });
        return { success: false, error: "no_observations" };
      }

      const chunkSize = getChunkSize();
      const estimatedChunks = Math.ceil(compressed.length / chunkSize);
      const maxChunks = getMaxChunks();

      const persistSummary = async (
        summary: SessionSummary,
        opts?: { fallback?: boolean; fallbackReason?: string; qualityScore?: number },
      ) => {
        const summaryForValidation = {
          title: summary.title,
          narrative: summary.narrative,
          keyDecisions: summary.keyDecisions,
          filesModified: summary.filesModified,
          concepts: summary.concepts,
        };
        const validation = validateOutput(
          SummaryOutputSchema,
          summaryForValidation,
          "mem::summarize",
        );

        if (!validation.valid) {
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          logger.warn("Summary validation failed", {
            sessionId,
            errors: validation.result.errors,
          });
          return { success: false as const, error: "validation_failed" };
        }

        const qualityScore = opts?.qualityScore ?? scoreSummary(summaryForValidation);
        await kv.set(KV.summaries, sessionId, summary);
        await safeAudit(kv, "compress", "mem::summarize", [sessionId], {
          title: summary.title,
          observationCount: compressed.length,
          fallback: opts?.fallback === true,
          fallbackReason: opts?.fallbackReason,
        });

        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record(
            "mem::summarize",
            latencyMs,
            true,
            qualityScore,
          );
        }

        logger.info("Session summarized", {
          sessionId,
          title: summary.title,
          decisions: summary.keyDecisions.length,
          qualityScore,
          valid: validation.valid,
          fallback: opts?.fallback === true,
        });

        return {
          success: true as const,
          summary,
          qualityScore,
          ...(opts?.fallback
            ? {
                fallback: true,
                fallbackReason: opts.fallbackReason || "deterministic_import_summary",
              }
            : {}),
        };
      };

      if (estimatedChunks > maxChunks) {
        const fallbackReason =
          `session_too_large_for_llm_summary: ${estimatedChunks} chunks exceeds SUMMARIZE_MAX_CHUNKS=${maxChunks}`;
        logger.warn("Summarize using deterministic fallback for oversized session", {
          sessionId,
          chunkSize,
          chunks: estimatedChunks,
          maxChunks,
          observationCount: compressed.length,
        });
        const fallbackSummary = buildDeterministicSummary(
          compressed,
          sessionId,
          session.project,
        );
        return persistSummary(fallbackSummary, {
          fallback: true,
          fallbackReason,
          qualityScore: 0,
        });
      }

      if (provider.name === "noop") {
        if (allowDeterministicFallback) {
          const fallbackSummary = buildDeterministicSummary(
            compressed,
            sessionId,
            session.project,
          );
          return persistSummary(fallbackSummary, {
            fallback: true,
            fallbackReason: "no_provider",
            qualityScore: 0,
          });
        }
        logger.info("Summarize skipped — no LLM provider configured", {
          sessionId,
        });
        return {
          success: false,
          error: "no_provider",
          reason:
            "No LLM provider key set; Summarize is a no-op. Set ANTHROPIC_API_KEY (or GEMINI/OPENROUTER/MINIMAX) in ~/.agentmemory/.env to enable.",
        };
      }

      try {
        // #783: chunk-level produceSummaryXml retries internally, but
        // the final merge used to parse once and bail. Wrap the
        // produce-and-parse pair in the same 2-attempt loop so a
        // markdown-wrapped or otherwise wrapped response gets a
        // second roll-of-the-dice instead of dropping the summary.
        let summary: SessionSummary | null = null;
        let response = "";
        let mode = "single";
        let chunks = 1;
        let fallbackReason: string | undefined;
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const produced = await produceSummaryXml(
              provider,
              compressed,
              sessionId,
              session.project,
            );
            response = produced.response;
            mode = produced.mode;
            chunks = produced.chunks;
          } catch (err) {
            fallbackReason = err instanceof Error ? err.message : String(err);
            if (!allowDeterministicFallback || attempt === 2) {
              throw err;
            }
            logger.warn("Summarize retrying after provider failure", {
              sessionId,
              attempt,
              error: fallbackReason,
            });
            continue;
          }
          if (!response || !response.trim()) {
            logger.warn("Empty provider response on summarize", {
              sessionId,
              provider: provider.name,
              mode,
              chunks,
              observationCount: compressed.length,
              attempt,
            });
            continue;
          }
          summary = parseSummaryXml(
            response,
            sessionId,
            session.project,
            compressed.length,
          );
          if (summary) break;
          logger.warn("Failed to parse summary XML", { sessionId, attempt });
        }

        if (!response || !response.trim()) {
          if (allowDeterministicFallback) {
            const fallbackSummary = buildDeterministicSummary(
              compressed,
              sessionId,
              session.project,
            );
            return persistSummary(fallbackSummary, {
              fallback: true,
              fallbackReason: fallbackReason || "empty_provider_response",
              qualityScore: 0,
            });
          }
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "empty_provider_response" };
        }

        if (!summary) {
          if (allowDeterministicFallback) {
            const fallbackSummary = buildDeterministicSummary(
              compressed,
              sessionId,
              session.project,
            );
            return persistSummary(fallbackSummary, {
              fallback: true,
              fallbackReason: "parse_failed",
              qualityScore: 0,
            });
          }
          const latencyMs = Date.now() - startMs;
          if (metricsStore) {
            await metricsStore.record("mem::summarize", latencyMs, false);
          }
          return { success: false, error: "parse_failed" };
        }

        return persistSummary(summary);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (allowDeterministicFallback) {
          const fallbackSummary = buildDeterministicSummary(
            compressed,
            sessionId,
            session.project,
          );
          return persistSummary(fallbackSummary, {
            fallback: true,
            fallbackReason: msg,
            qualityScore: 0,
          });
        }
        const latencyMs = Date.now() - startMs;
        if (metricsStore) {
          await metricsStore.record("mem::summarize", latencyMs, false);
        }
        logger.error("Summarize failed", {
          sessionId,
          error: msg,
        });
        return { success: false, error: msg };
      }
      };

      const promise = run();
      inFlight.set(sessionId, promise);
      try {
        return await promise;
      } finally {
        if (inFlight.get(sessionId) === promise) {
          inFlight.delete(sessionId);
        }
      }
    },
  );
}
