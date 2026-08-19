import { randomUUID } from "node:crypto";
import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import {
  CONTEXT_TIERS,
  resolveContextBudgets,
  type ContextBudgetInput,
  type ContextBudgets,
  type ContextEntry,
  type ContextTier,
  type ExpandableContextHandle,
  type TieredContext,
} from "./context-budget.js";
import {
  createDefaultRetrievalPlannerAdapters,
  deriveRetrievalRequirements,
  DeterministicRetrievalPlanner,
  type RetrievedCandidate,
  type RetrievalPlan,
  type RetrievalRequirements,
  type RetrievalScope,
} from "./retrieval-planner.js";
import { scoreText } from "./structured-records.js";
import {
  queryTemporalMemories,
  type RichMemory,
} from "./temporal-memory.js";
import {
  mergeRetrievalEvidence,
  retrievalEvidenceIds,
  summarizeRetrievalEvidence,
  summarizeEvidenceReference,
  summarizeRetrievalOrigin,
} from "./retrieval-metadata.js";

export const PLANNED_RETRIEVAL_CACHE_TTL_MS = 30_000;

const MAX_CACHED_PLANS = 64;
const MAX_TITLE_LENGTH = 160;

type StructuredSource =
  | "experiment"
  | "artifact"
  | "evidence"
  | "negative_memory";

type CoverageSource =
  | "hybrid"
  | "graph"
  | "memory"
  | "temporal_memory"
  | "experiments"
  | "artifacts"
  | "evidence"
  | "negative_memories";

interface TriggeringSdk {
  trigger(input: { function_id: string; payload: unknown }): Promise<unknown>;
}

interface ParsedPlanInput {
  query: string;
  project?: string;
  agentId?: string;
  limit?: number;
  budgets: ContextBudgetInput;
  tokenBudget?: number;
}

interface ParsedExpandInput {
  handle: string;
  scope: RetrievalScope;
  tokenBudget?: number;
}

interface SourceCoverage {
  source: CoverageSource;
  requested: boolean;
  available: boolean;
  received: number;
  filteredByTemporal?: number;
  error?: string;
}

interface CandidateDescriptor {
  id: string;
  contextId: string;
  kind: StructuredSource;
}

interface StructuredQueryResult {
  candidates: RetrievedCandidate[];
  descriptors: Map<string, CandidateDescriptor>;
  coverage: SourceCoverage;
}

interface NegativeWarning {
  id: string;
  score?: number;
  status?: string;
  shouldNotRetry: boolean;
}

interface LoadedStructuredSources {
  candidates: RetrievedCandidate[];
  descriptors: Map<string, CandidateDescriptor>;
  coverage: SourceCoverage[];
  negativeWarnings: NegativeWarning[];
}

interface TemporalMemoryResult {
  candidates: RetrievedCandidate[];
  coverage: SourceCoverage;
}

interface CachedPlan {
  expiresAt: number;
  scope: RetrievalScope;
  planner: DeterministicRetrievalPlanner;
  plan: RetrievalPlan;
  handles: Map<string, ExpandableContextHandle>;
}

export interface PublicRetrievalResult {
  id: string;
  contextId: string;
  kind: "memory" | StructuredSource;
  title: string;
  score: number;
  sources: string[];
  sessionId?: string;
  timestamp?: string;
  project?: string;
  agentId?: string;
  historical?: boolean;
  metadata?: RetrievedCandidate["retrievalMetadata"];
}

export interface PublicExpansionHandle {
  handle: string;
  itemId: string;
  tier: ContextTier;
  fullTokens: number;
  source?: string;
}

export interface PublicTieredContext {
  budgets: ContextBudgets;
  tiers: Record<ContextTier, ContextEntry[]>;
  omitted: Record<ContextTier, string[]>;
  tokensUsed: number;
  truncated: boolean;
  diagnostics: TieredContext["diagnostics"];
}

export interface PlannedRetrievalResponse {
  success: true;
  planId: string;
  expiresAt: string;
  query: string;
  requirements: RetrievalRequirements;
  scope: RetrievalScope;
  results: PublicRetrievalResult[];
  context: PublicTieredContext;
  handles: PublicExpansionHandle[];
  coverage: SourceCoverage[];
  negativeMemories: NegativeWarning[];
  diagnostics: Omit<RetrievalPlan["diagnostics"], "budget"> & {
    budget: TieredContext["diagnostics"];
  };
}

export interface PlannedRetrievalOptions {
  cacheTtlMs?: number;
  now?: () => number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function finiteScore(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function clampTitle(value: string): string {
  return value.length <= MAX_TITLE_LENGTH
    ? value
    : `${value.slice(0, MAX_TITLE_LENGTH - 3)}...`;
}

function scopeFrom(data: Record<string, unknown>): {
  scope: RetrievalScope;
  error?: string;
} {
  const nested = asRecord(data.scope);
  const scope: RetrievalScope = {};
  for (const field of ["project", "agentId"] as const) {
    const topLevel = data[field];
    const nestedValue = nested?.[field];
    if (
      topLevel !== undefined &&
      nestedValue !== undefined &&
      topLevel !== nestedValue
    ) {
      return { scope, error: `${field} must match scope.${field} when both are provided` };
    }
    const value = topLevel ?? nestedValue;
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) {
      return { scope, error: `${field} must be a non-empty string when provided` };
    }
    scope[field] = value.trim();
  }
  return { scope };
}

function parseBudgetInput(data: Record<string, unknown>): {
  budgets: ContextBudgetInput;
  tokenBudget?: number;
  error?: string;
} {
  const raw = data.budgets;
  if (raw !== undefined && !asRecord(raw)) {
    return { budgets: {}, error: "budgets must be an object when provided" };
  }
  const source = asRecord(raw) ?? {};
  const budgets: ContextBudgetInput = {};
  for (const field of ["total", ...CONTEXT_TIERS] as const) {
    const value = source[field];
    if (value === undefined) continue;
    if (!Number.isInteger(value) || (value as number) < 0) {
      return { budgets: {}, error: `budgets.${field} must be a non-negative integer` };
    }
    budgets[field] = value as number;
  }

  if (data.tokenBudget === undefined) return { budgets };
  if (!Number.isInteger(data.tokenBudget) || (data.tokenBudget as number) < 0) {
    return { budgets: {}, error: "tokenBudget must be a non-negative integer" };
  }
  return { budgets, tokenBudget: data.tokenBudget as number };
}

function parsePlanInput(input: unknown): { value?: ParsedPlanInput; error?: string } {
  const data = asRecord(input);
  if (!data) return { error: "retrieval plan input must be an object" };
  const query = optionalString(data.query);
  if (!query) return { error: "query is required" };
  const scope = scopeFrom(data);
  if (scope.error) return { error: scope.error };
  if (
    data.limit !== undefined &&
    (!Number.isInteger(data.limit) || (data.limit as number) <= 0)
  ) {
    return { error: "limit must be a positive integer when provided" };
  }
  const parsedBudget = parseBudgetInput(data);
  if (parsedBudget.error) return { error: parsedBudget.error };
  return {
    value: {
      query,
      ...scope.scope,
      ...(data.limit !== undefined ? { limit: Math.min(data.limit as number, 100) } : {}),
      budgets: parsedBudget.budgets,
      ...(parsedBudget.tokenBudget !== undefined
        ? { tokenBudget: parsedBudget.tokenBudget }
        : {}),
    },
  };
}

function parseExpandInput(input: unknown): { value?: ParsedExpandInput; error?: string } {
  const data = asRecord(input);
  if (!data) return { error: "retrieval expansion input must be an object" };
  const handle = optionalString(data.handle);
  if (!handle) return { error: "handle is required" };
  const parsedScope = scopeFrom(data);
  if (parsedScope.error) return { error: parsedScope.error };
  if (
    data.tokenBudget !== undefined &&
    (!Number.isInteger(data.tokenBudget) || (data.tokenBudget as number) < 0)
  ) {
    return { error: "tokenBudget must be a non-negative integer when provided" };
  }
  return {
    value: {
      handle,
      scope: parsedScope.scope,
      ...(data.tokenBudget !== undefined
        ? { tokenBudget: data.tokenBudget as number }
        : {}),
    },
  };
}

function sumTierBudgets(budgets: ContextBudgets): number {
  return CONTEXT_TIERS.reduce((sum, tier) => sum + budgets[tier], 0);
}

function capBudgets(budgets: ContextBudgets, total: number): ContextBudgets {
  const current = sumTierBudgets(budgets);
  if (current <= total) return { ...budgets, total };
  const capped = {} as Record<ContextTier, number>;
  const fractions: Array<{ tier: ContextTier; fraction: number }> = [];
  let allocated = 0;
  for (const tier of CONTEXT_TIERS) {
    const exact = (budgets[tier] * total) / current;
    capped[tier] = Math.floor(exact);
    allocated += capped[tier];
    fractions.push({ tier, fraction: exact - capped[tier] });
  }
  fractions.sort(
    (left, right) =>
      right.fraction - left.fraction ||
      CONTEXT_TIERS.indexOf(left.tier) - CONTEXT_TIERS.indexOf(right.tier),
  );
  for (let index = 0; allocated < total; index++, allocated++) {
    capped[fractions[index % fractions.length].tier]++;
  }
  return { total, ...capped };
}

function strictBudgets(
  budgetInput: ContextBudgetInput,
  tokenBudget?: number,
): ContextBudgets {
  const requestedTotal = [budgetInput.total, tokenBudget].filter(
    (value): value is number => value !== undefined,
  );
  const ceiling = requestedTotal.length > 0 ? Math.min(...requestedTotal) : undefined;
  const resolved = resolveContextBudgets({
    ...budgetInput,
    ...(ceiling !== undefined ? { total: ceiling } : {}),
  });
  return ceiling === undefined ? resolved : capBudgets(resolved, ceiling);
}

function scopeMatches(left: RetrievalScope, right: RetrievalScope): boolean {
  return left.project === right.project && left.agentId === right.agentId;
}

function recordStrings(record: Record<string, unknown>, fields: string[]): string[] {
  const values: string[] = [];
  for (const field of fields) {
    const value = record[field];
    if (typeof value === "string" && value.trim()) values.push(value.trim());
    if (Array.isArray(value)) {
      values.push(
        ...value.filter((item): item is string => typeof item === "string" && Boolean(item.trim())),
      );
    }
  }
  return values;
}

function recordTimestamp(record: Record<string, unknown>): string | undefined {
  for (const field of [
    "updatedAt",
    "capturedAt",
    "createdAt",
    "completedAt",
    "startedAt",
  ]) {
    const value = optionalString(record[field]);
    if (value) return value;
  }
  return undefined;
}

function recordEvidenceMetadata(
  kind: StructuredSource,
  id: string,
  record: Record<string, unknown>,
): RetrievedCandidate["retrievalMetadata"] {
  const ids = Array.isArray(record.evidenceIds)
    ? record.evidenceIds.filter((value): value is string => typeof value === "string")
    : [];
  const ownEvidence = kind === "evidence"
    ? summarizeEvidenceReference({
        id,
        kind: optionalString(record.kind ?? record.type) ?? kind,
        source: optionalString(record.source),
        locator: optionalString(record.locator),
        claim: optionalString(record.claim),
        capturedAt: optionalString(record.capturedAt),
        verifiedAt: optionalString(record.verifiedAt),
        verificationMethod: optionalString(record.verificationMethod),
      })
    : undefined;
  const evidence = mergeRetrievalEvidence(
    retrievalEvidenceIds(ids),
    ownEvidence
      ? { ids: [id], summaries: [ownEvidence] }
      : undefined,
  );
  const origin = summarizeRetrievalOrigin(provenanceFor(record));
  return origin || evidence ? { ...(origin ? { origin } : {}), ...(evidence ? { evidence } : {}) } : undefined;
}

function provenanceFor(record: Record<string, unknown>): RetrievedCandidate["provenance"] {
  const provenance = asRecord(record.provenance) ?? asRecord(record.origin);
  const channel = optionalString(provenance?.channel);
  const capturedAt = optionalString(provenance?.capturedAt);
  if (!channel && !capturedAt) return undefined;
  return {
    ...(channel ? { channel } : {}),
    ...(optionalString(provenance?.detail)
      ? { detail: optionalString(provenance?.detail) }
      : {}),
    ...(capturedAt ? { capturedAt } : {}),
  };
}

function recordMatchesTemporal(
  record: Record<string, unknown>,
  requirements: RetrievalRequirements,
): boolean {
  const timestamp = recordTimestamp(record);
  if (!timestamp) return true;
  if (requirements.temporal.mode === "as_of" && requirements.temporal.asOf) {
    return timestamp <= requirements.temporal.asOf;
  }
  if (requirements.temporal.mode === "range") {
    return (
      (!requirements.temporal.from || timestamp >= requirements.temporal.from) &&
      (!requirements.temporal.to || timestamp <= requirements.temporal.to)
    );
  }
  return true;
}

function structuredCandidate(
  kind: StructuredSource,
  record: Record<string, unknown>,
  query: string,
): { candidate?: RetrievedCandidate; descriptor?: CandidateDescriptor } {
  const id = optionalString(record.id);
  if (!id) return {};
  const config: Record<StructuredSource, { fields: string[]; title: string }> = {
    experiment: {
      fields: [
        "title",
        "objective",
        "hypothesis",
        "result",
        "conclusion",
        "followUp",
        "commands",
        "environment",
        "sourceRevision",
        "actionIds",
        "sessionIds",
      ],
      title: `Experiment ${id}`,
    },
    artifact: {
      fields: [
        "name",
        "kind",
        "type",
        "path",
        "uri",
        "description",
        "digest",
        "hash",
      ],
      title: `Artifact ${id}`,
    },
    evidence: {
      fields: [
        "kind",
        "type",
        "source",
        "locator",
        "content",
        "claim",
        "verificationMethod",
      ],
      title: `Evidence ${id}`,
    },
    negative_memory: {
      fields: [
        "approach",
        "statement",
        "reason",
        "outcome",
        "environment",
        "sourceRevision",
      ],
      title: `Negative memory ${id}`,
    },
  };
  const content = recordStrings(record, config[kind].fields).join("\n");
  if (!content) return {};
  const score = finiteScore(record.score) ?? scoreText(query, content);
  const contextId = `${kind}:${id}`;
  return {
    candidate: {
      id: contextId,
      title: config[kind].title,
      content,
      score: score > 0 ? score : 0.01,
      source: "memory",
      timestamp: recordTimestamp(record),
      project: optionalString(record.project),
      agentId: optionalString(record.agentId),
    provenance: provenanceFor(record),
    authority: asRecord(record.authority) ?? undefined,
     metadata: { kind, recordId: id },
     retrievalMetadata: recordEvidenceMetadata(kind, id, record),
    },
    descriptor: { id, contextId, kind },
  };
}

function memoryClaims(memory: RichMemory): Record<string, string> | undefined {
  const claims = asRecord((memory as unknown as Record<string, unknown>).claims);
  if (!claims) return undefined;
  const values = Object.entries(claims).filter(
    (entry): entry is [string, string] => typeof entry[1] === "string",
  );
  return values.length > 0 ? Object.fromEntries(values) : undefined;
}

function memoryCandidate(
  memory: RichMemory,
  query: string,
  requirements?: RetrievalRequirements,
): RetrievedCandidate | null {
  const content = `${memory.title}\n${memory.content}`.trim();
  const score = scoreText(query, `${content} ${memory.concepts.join(" ")}`);
  if (score <= 0) return null;
  const temporal = asRecord(memory.temporal);
  const temporalStart =
    optionalString(temporal?.validFrom) ??
    optionalString(temporal?.observedAt) ??
    memory.updatedAt;
  const timestamp = requirements?.temporal.mode === "range"
    ? requirements.temporal.from && temporalStart < requirements.temporal.from
      ? requirements.temporal.from
      : temporalStart
    : temporalStart;
  const origin = memory.origin ? summarizeRetrievalOrigin(memory.origin) : undefined;
  const evidence = retrievalEvidenceIds(memory.evidenceIds);
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content,
    score,
    source: "memory",
    sessionId: memory.sessionIds[0],
    timestamp,
    project: memory.project,
    agentId: memory.agentId,
    concepts: memory.concepts,
    historical: memory.isLatest === false,
    provenance: memory.origin,
    sourceObservationIds: memory.sourceObservationIds,
    authority: memory.authority,
    claims: memoryClaims(memory),
    retrievalMetadata: origin || evidence
      ? { ...(origin ? { origin } : {}), ...(evidence ? { evidence } : {}) }
      : undefined,
  };
}

async function loadTemporalMemoryCandidates(
  kv: StateKV,
  query: string,
  requirements: RetrievalRequirements,
  scope: RetrievalScope,
  limit: number,
): Promise<TemporalMemoryResult> {
  const coverage: SourceCoverage = {
    source: "temporal_memory",
    requested: requirements.temporal.mode !== "none",
    available: true,
    received: 0,
  };
  if (requirements.temporal.mode === "none") return { candidates: [], coverage };

  try {
    let memories: RichMemory[];
    if (requirements.temporal.mode === "historical") {
      memories = await kv.list<RichMemory>(KV.memories);
      memories = memories.filter((memory) => memory.isLatest === false);
    } else {
      const result = await queryTemporalMemories(kv, {
        ...scope,
        ...(requirements.temporal.mode === "as_of"
          ? { asOf: requirements.temporal.asOf }
          : requirements.temporal.mode === "range"
            ? { from: requirements.temporal.from, to: requirements.temporal.to }
            : { mode: "current" }),
      });
      if (result.success !== true) {
        coverage.available = false;
        coverage.error = typeof result.error === "string" ? result.error : "temporal memory query failed";
        return { candidates: [], coverage };
      }
      memories = Array.isArray(result.memories)
        ? (result.memories as RichMemory[])
        : [];
    }
     const candidates = (await Promise.all(memories
       .filter(
        (memory) =>
          (scope.project === undefined || memory.project === scope.project) &&
          (scope.agentId === undefined ||
            scope.agentId === "*" ||
            memory.agentId === scope.agentId),
      )
       .map(async (memory) => {
         const candidate = memoryCandidate(memory, query, requirements);
         if (!candidate) return null;
         const evidence = await summarizeRetrievalEvidence(kv, memory.evidenceIds, scope);
         if (!evidence) return candidate;
         return {
           ...candidate,
           retrievalMetadata: {
             ...(candidate.retrievalMetadata ?? {}),
             evidence,
           },
         };
       })))
       .filter((candidate): candidate is RetrievedCandidate => candidate !== null)
      .sort((left, right) => right.score - left.score || left.id.localeCompare(right.id))
      .slice(0, limit)
      .map((candidate) => ({
        ...candidate,
        ...(requirements.temporal.mode === "historical" ||
        requirements.temporal.mode === "as_of"
          ? { historical: true }
          : {}),
      }));
    coverage.received = candidates.length;
    return { candidates, coverage };
  } catch (error) {
    coverage.available = false;
    coverage.error = errorMessage(error);
    return { candidates: [], coverage };
  }
}

async function queryStructuredSource(
  sdk: TriggeringSdk,
  source: Exclude<StructuredSource, "negative_memory">,
  functionId: string,
  field: string,
  query: string,
  scope: RetrievalScope,
  limit: number,
  requirements: RetrievalRequirements,
): Promise<StructuredQueryResult> {
  const coverage: SourceCoverage = {
    source:
      source === "experiment"
        ? "experiments"
        : source === "artifact"
          ? "artifacts"
          : "evidence",
    requested: true,
    available: false,
    received: 0,
  };
  try {
    const response = asRecord(
      await sdk.trigger({
        function_id: functionId,
        payload: { query, limit, ...scope },
      }),
    );
    if (!response || response.success === false) {
      coverage.error = optionalString(response?.error) ?? "structured query failed";
      return { candidates: [], descriptors: new Map(), coverage };
    }
    const records = Array.isArray(response[field])
      ? response[field].map(asRecord).filter((record): record is Record<string, unknown> => record !== null)
      : [];
    coverage.available = true;
    const descriptors = new Map<string, CandidateDescriptor>();
    let filteredByTemporal = 0;
    const candidates = records.flatMap((record) => {
      if (!recordMatchesTemporal(record, requirements)) {
        filteredByTemporal++;
        return [];
      }
      const structured = structuredCandidate(source, record, query);
      if (!structured.candidate || !structured.descriptor) return [];
      descriptors.set(structured.descriptor.contextId, structured.descriptor);
      return [structured.candidate];
    });
    coverage.received = candidates.length;
    if (filteredByTemporal > 0) coverage.filteredByTemporal = filteredByTemporal;
    return { candidates, descriptors, coverage };
  } catch (error) {
    coverage.error = errorMessage(error);
    return { candidates: [], descriptors: new Map(), coverage };
  }
}

async function queryNegativeMemories(
  sdk: TriggeringSdk,
  query: string,
  scope: RetrievalScope,
  limit: number,
  requirements: RetrievalRequirements,
): Promise<StructuredQueryResult & { warnings: NegativeWarning[] }> {
  const coverage: SourceCoverage = {
    source: "negative_memories",
    requested: true,
    available: false,
    received: 0,
  };
  try {
    const response = asRecord(
      await sdk.trigger({
        function_id: "mem::negative-memory-lookup",
        payload: {
          query,
          limit,
          ...scope,
          ...(requirements.temporal.mode === "as_of" && requirements.temporal.asOf
            ? { asOf: requirements.temporal.asOf }
            : {}),
        },
      }),
    );
    if (!response || response.success === false) {
      coverage.error = optionalString(response?.error) ?? "negative memory lookup failed";
      return {
        candidates: [],
        descriptors: new Map(),
        coverage,
        warnings: [],
      };
    }
    const records = Array.isArray(response.negativeMemories)
      ? response.negativeMemories
          .map(asRecord)
          .filter((record): record is Record<string, unknown> => record !== null)
      : [];
    coverage.available = true;
    const descriptors = new Map<string, CandidateDescriptor>();
    let filteredByTemporal = 0;
    const candidates = records.flatMap((record) => {
      if (!recordMatchesTemporal(record, requirements)) {
        filteredByTemporal++;
        return [];
      }
      const structured = structuredCandidate("negative_memory", record, query);
      if (!structured.candidate || !structured.descriptor) return [];
      descriptors.set(structured.descriptor.contextId, structured.descriptor);
      return [structured.candidate];
    });
    coverage.received = candidates.length;
    if (filteredByTemporal > 0) coverage.filteredByTemporal = filteredByTemporal;
    const shouldNotRetry = response.shouldNotRetry === true;
    const warnings = records.flatMap((record) => {
      const id = optionalString(record.id);
      return id
        ? [{
            id,
            ...(finiteScore(record.score) !== undefined ? { score: finiteScore(record.score) } : {}),
            ...(optionalString(record.status) ? { status: optionalString(record.status) } : {}),
            shouldNotRetry,
          }]
        : [];
    });
    return { candidates, descriptors, coverage, warnings };
  } catch (error) {
    coverage.error = errorMessage(error);
    return {
      candidates: [],
      descriptors: new Map(),
      coverage,
      warnings: [],
    };
  }
}

async function loadStructuredSources(
  sdk: TriggeringSdk,
  input: ParsedPlanInput,
  requirements: RetrievalRequirements,
): Promise<LoadedStructuredSources> {
  const scope: RetrievalScope = {
    ...(input.project ? { project: input.project } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
  };
  const limit = input.limit ?? 20;
  const [experiments, artifacts, evidence, negatives] = await Promise.all([
    queryStructuredSource(
      sdk,
      "experiment",
      "mem::experiment-query",
      "experiments",
      input.query,
      scope,
      limit,
      requirements,
    ),
    queryStructuredSource(
      sdk,
      "artifact",
      "mem::artifact-query",
      "artifacts",
      input.query,
      scope,
      limit,
      requirements,
    ),
    queryStructuredSource(
      sdk,
      "evidence",
      "mem::evidence-query",
      "evidence",
      input.query,
      scope,
      limit,
      requirements,
    ),
    queryNegativeMemories(sdk, input.query, scope, limit, requirements),
  ]);
  const descriptors = new Map<string, CandidateDescriptor>();
  for (const source of [experiments, artifacts, evidence, negatives]) {
    for (const [contextId, descriptor] of source.descriptors) {
      descriptors.set(contextId, descriptor);
    }
  }
  return {
    candidates: [
      ...experiments.candidates,
      ...artifacts.candidates,
      ...evidence.candidates,
      ...negatives.candidates,
    ],
    descriptors,
    coverage: [
      experiments.coverage,
      artifacts.coverage,
      evidence.coverage,
      negatives.coverage,
    ],
    negativeWarnings: negatives.warnings,
  };
}

function publicResult(
  result: RetrievalPlan["results"][number],
  descriptors: Map<string, CandidateDescriptor>,
): PublicRetrievalResult {
  const descriptor = descriptors.get(result.id);
  return {
    id: descriptor?.id ?? result.id,
    contextId: result.id,
    kind: descriptor?.kind ?? "memory",
    title: clampTitle(result.title),
    score: result.score,
    sources: descriptor ? [descriptor.kind] : result.sources.slice(),
    ...(result.sessionId ? { sessionId: result.sessionId } : {}),
    ...(result.timestamp ? { timestamp: result.timestamp } : {}),
    ...(result.project ? { project: result.project } : {}),
    ...(result.agentId ? { agentId: result.agentId } : {}),
    ...(result.historical ? { historical: true } : {}),
    ...(result.metadata ? { metadata: result.metadata } : {}),
  };
}

function makePublicContext(
  context: TieredContext,
  handles: Map<string, string>,
): PublicTieredContext {
  const tiers = {} as Record<ContextTier, ContextEntry[]>;
  for (const tier of CONTEXT_TIERS) {
    tiers[tier] = context.tiers[tier].map((entry) => ({
      ...entry,
      ...(entry.expandHandle
        ? { expandHandle: handles.get(entry.expandHandle) }
        : {}),
    }));
  }
  return {
    budgets: context.budgets,
    tiers,
    omitted: context.omitted,
    tokensUsed: context.tokensUsed,
    truncated: context.truncated,
    diagnostics: context.diagnostics,
  };
}

function sourceCoverage(
  plan: RetrievalPlan,
  temporal: SourceCoverage,
  structured: SourceCoverage[],
  memoryReceived: number,
  memoryError?: string,
): SourceCoverage[] {
  const core = plan.diagnostics.sources.map((source) => ({
    source: source.source as "hybrid" | "graph" | "memory",
    requested: source.requested,
    available: source.available && !source.error,
    received: source.received,
    ...(source.error ? { error: source.error } : {}),
  }));
  const memory = core.find((entry) => entry.source === "memory");
  if (memory) {
    memory.received = memoryReceived;
    if (memoryError) {
      memory.available = false;
      memory.error = memoryError;
    }
  }
  return [...core, temporal, ...structured];
}

function expirationTimestamp(now: number, ttlMs: number): string {
  return new Date(now + ttlMs).toISOString();
}

export function registerPlannedRetrievalFunctions(
  sdk: ISdk,
  kv: StateKV,
  options: PlannedRetrievalOptions = {},
): void {
  const triggerSdk = sdk as unknown as TriggeringSdk;
  const now = options.now ?? Date.now;
  const configuredCacheTtl =
    typeof options.cacheTtlMs === "number" &&
    Number.isFinite(options.cacheTtlMs)
      ? Math.floor(options.cacheTtlMs)
      : PLANNED_RETRIEVAL_CACHE_TTL_MS;
  const cacheTtlMs = Math.max(
    1,
    Math.min(configuredCacheTtl, PLANNED_RETRIEVAL_CACHE_TTL_MS),
  );
  const cache = new Map<string, CachedPlan>();

  const clearExpired = () => {
    const timestamp = now();
    for (const [planId, entry] of cache) {
      if (entry.expiresAt <= timestamp) cache.delete(planId);
    }
  };

  const plan = async (input: unknown): Promise<PlannedRetrievalResponse | { success: false; error: string }> => {
    const parsed = parsePlanInput(input);
    if (!parsed.value) return { success: false, error: parsed.error ?? "invalid retrieval plan input" };
    const data = parsed.value;
    const requirements = deriveRetrievalRequirements(data.query);
    const scope: RetrievalScope = {
      ...(data.project ? { project: data.project } : {}),
      ...(data.agentId ? { agentId: data.agentId } : {}),
    };
    const limit = data.limit ?? 20;
    const [structured, temporal] = await Promise.all([
      loadStructuredSources(triggerSdk, data, requirements),
      loadTemporalMemoryCandidates(kv, data.query, requirements, scope, limit),
    ]);
    const defaultAdapters = createDefaultRetrievalPlannerAdapters(triggerSdk, kv);
    let memoryError: string | undefined;
    let memoryReceived = 0;
    const planner = new DeterministicRetrievalPlanner({
      hybrid: defaultAdapters.hybrid,
      graph: defaultAdapters.graph,
      memory: async (request) => {
        let memories: RetrievedCandidate[] = [];
        if (request.temporal.mode === "none" && defaultAdapters.memory) {
          try {
            memories = await defaultAdapters.memory(request);
            memoryReceived = memories.length;
          } catch (error) {
            memoryError = errorMessage(error);
          }
        }
        return [...memories, ...temporal.candidates, ...structured.candidates];
      },
    });
    const budgets = strictBudgets(data.budgets, data.tokenBudget);
    const retrievalPlan = await planner.plan({
      query: data.query,
      ...scope,
      limit,
      budgets,
    });

    clearExpired();
    while (cache.size >= MAX_CACHED_PLANS) {
      const oldest = cache.keys().next().value;
      if (!oldest) break;
      cache.delete(oldest);
    }
    const planId = `rpl_${randomUUID()}`;
    const privateHandles = new Map<string, ExpandableContextHandle>();
    const publicHandleByPrivate = new Map<string, string>();
    const publicHandles = retrievalPlan.context.handles.map((handle) => {
      const opaqueHandle = `rph_${randomUUID()}`;
      privateHandles.set(opaqueHandle, handle);
      publicHandleByPrivate.set(handle.handle, opaqueHandle);
      return {
        handle: opaqueHandle,
        itemId: handle.itemId,
        tier: handle.tier,
        fullTokens: handle.fullTokens,
        ...(handle.source ? { source: handle.source } : {}),
      };
    });
    const createdAt = now();
    const expiresAt = createdAt + cacheTtlMs;
    cache.set(planId, {
      expiresAt,
      scope,
      planner,
      plan: retrievalPlan,
      handles: privateHandles,
    });

    return {
      success: true,
      planId,
      expiresAt: expirationTimestamp(createdAt, cacheTtlMs),
      query: retrievalPlan.query,
      requirements: retrievalPlan.requirements,
      scope: retrievalPlan.scope,
      results: retrievalPlan.results.map((result) => publicResult(result, structured.descriptors)),
      context: makePublicContext(retrievalPlan.context, publicHandleByPrivate),
      handles: publicHandles,
      coverage: sourceCoverage(
        retrievalPlan,
        temporal.coverage,
        structured.coverage,
        memoryReceived,
        memoryError,
      ),
      negativeMemories: structured.negativeWarnings,
      diagnostics: retrievalPlan.diagnostics,
    };
  };

  const expand = async (input: unknown) => {
    const parsed = parseExpandInput(input);
    if (!parsed.value) return { success: false, error: parsed.error ?? "invalid retrieval expansion input" };
    clearExpired();
    let cached: CachedPlan | undefined;
    let privateHandle: ExpandableContextHandle | undefined;
    for (const entry of cache.values()) {
      const handle = entry.handles.get(parsed.value.handle);
      if (handle) {
        cached = entry;
        privateHandle = handle;
        break;
      }
    }
    if (!cached || !privateHandle) {
      return { success: false, error: "retrieval expansion handle not found or expired" };
    }
    if (!scopeMatches(cached.scope, parsed.value.scope)) {
      return { success: false, error: "retrieval expansion scope does not match plan" };
    }
    const expanded = cached.planner.expand(
      cached.plan,
      privateHandle,
      parsed.value.tokenBudget,
    );
    return expanded
      ? { success: true, expansion: expanded }
      : { success: false, error: "retrieval expansion is unavailable" };
  };

  sdk.registerFunction("mem::retrieval-plan", plan);
  sdk.registerFunction("mem::retrieval-expand", expand);
}
