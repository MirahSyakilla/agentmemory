import type { ISdk } from "iii-sdk";
import type {
  ContextReductionAccounting,
  ContextReductionEvent,
  ContextReductionSource,
  ContextReductionSourceStats,
  ContextReductionStats,
} from "../types.js";
import { KV } from "../state/schema.js";
import { StateKV } from "../state/kv.js";
import { withKeyedLock } from "../state/keyed-mutex.js";
import { safeAudit } from "./audit.js";
import {
  buildRetrievalSavingsStats,
  createRetrievalSavingsCalculator,
} from "./retrieval-savings.js";

const CONTEXT_REDUCTION_SOURCES = new Set<ContextReductionSource>([
  "session_start",
  "pre_compact",
  "pre_tool_use",
  "mcp_recall",
  "mcp_smart_search",
  "mcp_vision_search",
]);
const AUTOMATIC_INJECTION_SOURCES = new Set<ContextReductionSource>([
  "session_start",
  "pre_compact",
  "pre_tool_use",
]);

export function isContextReductionSource(
  value: unknown,
): value is ContextReductionSource {
  return (
    typeof value === "string" &&
    CONTEXT_REDUCTION_SOURCES.has(value as ContextReductionSource)
  );
}

function isNonNegativeInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

export function isContextReductionAccounting(
  value: unknown,
): value is ContextReductionAccounting {
  if (!value || typeof value !== "object") return false;
  const accounting = value as Record<string, unknown>;
  return (
    typeof accounting.eventId === "string" &&
    accounting.eventId.length > 0 &&
    accounting.eventId.length <= 128 &&
    typeof accounting.estimator === "string" &&
    accounting.estimator.length > 0 &&
    accounting.estimator.length <= 64 &&
    isNonNegativeInteger(accounting.baselineTokens) &&
    isNonNegativeInteger(accounting.returnedTokens) &&
    typeof accounting.tokenDelta === "number" &&
    Number.isInteger(accounting.tokenDelta) &&
    accounting.tokenDelta ===
      Number(accounting.baselineTokens) - Number(accounting.returnedTokens)
  );
}

function emptySourceStats(): ContextReductionSourceStats {
  return {
    measuredEvents: 0,
    baselineTokens: 0,
    returnedTokens: 0,
    tokenDelta: 0,
  };
}

export function summarizeContextReductionEvents(
  events: ContextReductionEvent[],
  project?: string,
): ContextReductionStats {
  const filtered = project
    ? events.filter((event) => event.project === project)
    : events;
  const automaticInjection = emptySourceStats();
  const onDemandRecall = emptySourceStats();
  const bySource: ContextReductionStats["bySource"] = {};
  const estimators = new Set<string>();

  for (const event of filtered) {
    estimators.add(event.estimator);
    const deliveryGroup = AUTOMATIC_INJECTION_SOURCES.has(event.source)
      ? automaticInjection
      : onDemandRecall;
    deliveryGroup.measuredEvents += 1;
    deliveryGroup.baselineTokens += event.baselineTokens;
    deliveryGroup.returnedTokens += event.returnedTokens;
    deliveryGroup.tokenDelta += event.tokenDelta;
    const sourceTotals = bySource[event.source] ?? emptySourceStats();
    sourceTotals.measuredEvents += 1;
    sourceTotals.baselineTokens += event.baselineTokens;
    sourceTotals.returnedTokens += event.returnedTokens;
    sourceTotals.tokenDelta += event.tokenDelta;
    bySource[event.source] = sourceTotals;
  }

  const ordered = [...filtered].sort((a, b) =>
    a.timestamp.localeCompare(b.timestamp),
  );
  const reductionPercent =
    automaticInjection.baselineTokens > 0
      ? Math.round(
          (automaticInjection.tokenDelta /
            automaticInjection.baselineTokens) *
            1000,
        ) / 10
      : null;

  return {
    ...automaticInjection,
    estimator:
      estimators.size === 0
        ? "chars_div_3_v1"
        : estimators.size === 1
          ? [...estimators][0]
          : "mixed",
    reductionPercent,
    firstMeasuredAt: ordered[0]?.timestamp ?? null,
    lastMeasuredAt: ordered.at(-1)?.timestamp ?? null,
    automaticInjection,
    onDemandRecall,
    bySource,
    ...(project ? { project } : {}),
  };
}

export function registerContextReductionFunctions(
  sdk: ISdk,
  kv: StateKV,
): void {
  const calculateRetrievalCorpus = createRetrievalSavingsCalculator(kv);
  sdk.registerFunction(
    "mem::context-reduction-record",
    async (data: {
      accounting: ContextReductionAccounting;
      source: ContextReductionSource;
      sessionId?: string;
      project?: string;
    }) => {
      if (!isContextReductionAccounting(data?.accounting)) {
        return { success: false, error: "valid accounting is required" };
      }
      if (!isContextReductionSource(data?.source)) {
        return { success: false, error: "valid source is required" };
      }

      const sessionId =
        typeof data.sessionId === "string" && data.sessionId.trim()
          ? data.sessionId.trim().slice(0, 256)
          : undefined;
      const project =
        typeof data.project === "string" && data.project.trim()
          ? data.project.trim().slice(0, 512)
          : undefined;

      return withKeyedLock(
        `context-reduction:${data.accounting.eventId}`,
        async () => {
          const existing = await kv.get<ContextReductionEvent>(
            KV.contextReductionEvents,
            data.accounting.eventId,
          );
          if (existing) {
            return { success: true, deduplicated: true, event: existing };
          }

          const timestamp = new Date().toISOString();
          const event: ContextReductionEvent = {
            ...data.accounting,
            source: data.source,
            timestamp,
            ...(sessionId ? { sessionId } : {}),
            ...(project ? { project } : {}),
          };
          await kv.set(
            KV.contextReductionEvents,
            event.eventId,
            event,
          );
          await safeAudit(
            kv,
            "context_reduction_record",
            "mem::context-reduction-record",
            [event.eventId],
            {
              source: event.source,
              baselineTokens: event.baselineTokens,
              returnedTokens: event.returnedTokens,
              tokenDelta: event.tokenDelta,
              estimator: event.estimator,
              ...(event.project ? { project: event.project } : {}),
            },
          );
          return { success: true, deduplicated: false, event };
        },
      );
    },
  );

  sdk.registerFunction(
    "mem::context-reduction-stats",
    async (data?: { project?: string }) => {
      const project =
        typeof data?.project === "string" && data.project.trim()
          ? data.project.trim()
          : undefined;
      const events = await kv.list<ContextReductionEvent>(
        KV.contextReductionEvents,
      );
      const summary = summarizeContextReductionEvents(events, project);
      try {
        const corpus = await calculateRetrievalCorpus(project);
        return {
          ...summary,
          retrievalSavings: buildRetrievalSavingsStats(corpus, summary.onDemandRecall),
        };
      } catch {
        return { ...summary, retrievalSavings: null };
      }
    },
  );
}
