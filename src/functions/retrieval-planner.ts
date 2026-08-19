import type {
  Memory,
  MemoryRelation,
  CompressedObservation,
  Session,
  RetrievalResultMetadata,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import { GraphRetrieval } from "./graph-retrieval.js";
import {
  mergeRetrievalEvidence,
  retrievalEvidenceIds,
  summarizeRetrievalEvidence,
  summarizeRetrievalOrigin,
} from "./retrieval-metadata.js";
import {
  type ContextBudgetInput,
  type ContextBudgetItem,
  type ContextTier,
  type ExpandableContextHandle,
  type ExpandedContext,
  type TieredContext,
  expandContextHandle,
  partitionContext,
} from "./context-budget.js";

export type RetrievalIntent =
  | "debugging"
  | "implementation"
  | "decision"
  | "timeline"
  | "comparison"
  | "preference"
  | "provenance"
  | "fact"
  | "general";

export type TemporalMode = "none" | "current" | "historical" | "as_of" | "range";

export interface TemporalRequirement {
  mode: TemporalMode;
  asOf?: string;
  from?: string;
  to?: string;
}

export interface RetrievalRequirements {
  intent: RetrievalIntent;
  entities: string[];
  temporal: TemporalRequirement;
  evidenceRequired: boolean;
  negativeTerms: string[];
}

export interface RetrievalScope {
  project?: string;
  agentId?: string;
}

export type RetrievalSource = "hybrid" | "graph" | "memory";

export interface RetrievedCandidate {
  id: string;
  title: string;
  content: string;
  score: number;
  source?: RetrievalSource;
  sources?: RetrievalSource[];
  sessionId?: string;
  timestamp?: string;
  project?: string;
  agentId?: string;
  concepts?: string[];
  confidence?: number;
  importance?: number;
  historical?: boolean;
  provenance?: {
    channel?: string;
    detail?: string;
    capturedAt?: string;
  };
  sourceObservationIds?: string[];
  metadata?: Record<string, unknown>;
  retrievalMetadata?: RetrievalResultMetadata;
  graphContext?: string;
  conflictsWith?: string[];
  claims?: Record<string, string>;
  authority?: {
    source?: string;
    score?: number;
    confidence?: number;
    weight?: number;
  };
}

export interface RetrievalRequest extends RetrievalRequirements {
  query: string;
  limit: number;
  scope: RetrievalScope;
}

export type RetrievalAdapter = (
  request: RetrievalRequest,
) => Promise<RetrievedCandidate[]>;

export interface RetrievalPlannerAdapters {
  hybrid?: RetrievalAdapter;
  graph?: RetrievalAdapter;
  memory?: RetrievalAdapter;
}

export interface RetrievalPlanInput {
  query: string;
  project?: string;
  agentId?: string;
  limit?: number;
  tokenBudget?: number;
  budgets?: ContextBudgetInput;
}

export interface RetrievalSourceDiagnostic {
  source: RetrievalSource;
  available: boolean;
  requested: boolean;
  received: number;
  error?: string;
}

export interface NegativeMatch {
  candidateId: string;
  terms: string[];
}

export interface ConflictMatch {
  candidateIds: [string, string];
  reason: "explicit_relation" | "claim_value";
  claim?: string;
}

export interface RetrievalPlanDiagnostics {
  sources: RetrievalSourceDiagnostic[];
  receivedCandidates: number;
  uniqueCandidates: number;
  duplicateCandidates: number;
  filteredByProject: number;
  filteredByAgent: number;
  filteredByTemporal: number;
  scopeUnverified: number;
  negativeMatches: NegativeMatch[];
  conflicts: ConflictMatch[];
  conflictDetectionAvailable: boolean;
  budget: TieredContext["diagnostics"];
}

export interface PlannedRetrievalResult {
  id: string;
  title: string;
  score: number;
  sources: RetrievalSource[];
  sessionId?: string;
  timestamp?: string;
  project?: string;
  agentId?: string;
  historical?: boolean;
  metadata?: RetrievalResultMetadata;
}

export interface RetrievalPlan {
  query: string;
  requirements: RetrievalRequirements;
  scope: RetrievalScope;
  results: PlannedRetrievalResult[];
  context: TieredContext;
  diagnostics: RetrievalPlanDiagnostics;
}

export interface RetrievalSdk {
  trigger(input: { function_id: string; payload: unknown }): Promise<unknown>;
}

const SOURCE_ORDER: readonly RetrievalSource[] = ["hybrid", "graph", "memory"];

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

const ENTITY_STOP_WORDS = new Set([
  "a",
  "an",
  "and",
  "are",
  "as",
  "at",
  "be",
  "before",
  "between",
  "but",
  "by",
  "can",
  "could",
  "did",
  "do",
  "does",
  "for",
  "from",
  "has",
  "have",
  "how",
  "i",
  "in",
  "is",
  "it",
  "last",
  "latest",
  "me",
  "not",
  "of",
  "on",
  "or",
  "please",
  "recent",
  "show",
  "that",
  "the",
  "this",
  "to",
  "was",
  "what",
  "when",
  "where",
  "which",
  "who",
  "why",
  "with",
  "without",
]);

function normalizeOptionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function normalizedUnique(values: Iterable<string>): string[] {
  const valuesByFolded = new Map<string, string>();
  for (const raw of values) {
    const value = raw.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const existing = valuesByFolded.get(key);
    if (!existing || compareText(value, existing) < 0) {
      valuesByFolded.set(key, value);
    }
  }
  return Array.from(valuesByFolded.values()).sort(
    (a, b) => compareText(a.toLowerCase(), b.toLowerCase()) || compareText(a, b),
  );
}

function dateFromText(value: string): string | undefined {
  const match = value.match(/\b\d{4}-\d{2}-\d{2}(?:T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:?\d{2})?)?\b/);
  return match?.[0];
}

function extractKeywords(text: string): string[] {
  return normalizedUnique(
    text
      .split(/[^A-Za-z0-9_./@:-]+/)
      .map((token) => token.replace(/^[-:]+|[-:]+$/g, ""))
      .filter(
        (token) => token.length > 1 && !ENTITY_STOP_WORDS.has(token.toLowerCase()),
      ),
  );
}

function extractEntities(query: string): string[] {
  const values: string[] = [];
  for (const pattern of [/["`]([^"`]+)["`]/g, /\b[\w.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|go|rs|java|rb|cs|sql)\b/gi, /\b[A-Z][A-Za-z0-9_.-]{1,}\b/g]) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(query)) !== null) {
      values.push(match[1] ?? match[0]);
    }
  }
  for (const match of query.matchAll(/\b(?:entity|component|module|package|file)\s*:\s*([\w./@-]+)/gi)) {
    values.push(match[1]);
  }
  for (const match of query.matchAll(/\b(?:[\w@.-]+\/)+[\w@.-]+\.(?:[cm]?[jt]sx?|json|ya?ml|md|py|go|rs|java|rb|cs|sql)\b/gi)) {
    values.push(match[0]);
  }
  const normalized = normalizedUnique(
    values.filter((value) => !ENTITY_STOP_WORDS.has(value.toLowerCase())),
  );
  const fullPaths = new Set(normalized.filter((value) => value.includes("/")));
  return normalized.filter(
    (value) => !fullPaths.has(`src/${value}`) && !fullPaths.has(`lib/${value}`),
  );
}

function deriveTemporalRequirement(query: string): TemporalRequirement {
  const lowered = query.toLowerCase();
  const range = lowered.match(
    /\b(?:from|between)\s+(\d{4}-\d{2}-\d{2}(?:t[^\s,;]+)?)\s+(?:to|and)\s+(\d{4}-\d{2}-\d{2}(?:t[^\s,;]+)?)/i,
  );
  if (range) return { mode: "range", from: range[1], to: range[2] };

  const asOfMatch = lowered.match(/\b(?:as of|before|until)\s+([^,;.?]+)/i);
  const asOf = asOfMatch ? dateFromText(asOfMatch[1]) : undefined;
  if (asOf) return { mode: "as_of", asOf };

  if (/\b(history|historical|previous|formerly|was|changed from|before)\b/i.test(query)) {
    return { mode: "historical" };
  }
  if (/\b(current|latest|recent|now|today)\b/i.test(query)) {
    return { mode: "current" };
  }
  return { mode: "none" };
}

function deriveIntent(query: string, temporal: TemporalRequirement): RetrievalIntent {
  const lowered = query.toLowerCase();
  if (/\b(error|bug|fail(?:ed|ing|ure)?|exception|regression|broken|debug)\b/.test(lowered)) {
    return "debugging";
  }
  if (/\b(implement|build|add|create|change|edit|refactor|fix)\b/.test(lowered)) {
    return "implementation";
  }
  if (temporal.mode !== "none") return "timeline";
  if (/\b(compare|comparison|versus|vs\.?|difference|trade-?off)\b/.test(lowered)) {
    return "comparison";
  }
  if (/\b(evidence|citation|source|provenance|verify|prove)\b/.test(lowered)) {
    return "provenance";
  }
  if (/\b(decision|decide|chosen|why)\b/.test(lowered)) return "decision";
  if (/\b(prefer(?:ence|red)?|setting|convention)\b/.test(lowered)) {
    return "preference";
  }
  if (/\b(what|when|where|who|which|how)\b/.test(lowered)) return "fact";
  return "general";
}

function extractNegativeTerms(query: string): string[] {
  const values: string[] = [];
  for (const match of query.matchAll(/(?:\bwithout\b|\bexclude(?:\s+the)?\b|\bexcluding\b|\bexcept\b|\bavoid\b|\bbut\s+not\b)\s+([^,;?.]+)/gi)) {
    values.push(...extractKeywords(match[1]));
  }
  for (const match of query.matchAll(/(?:^|\s)-([\w./@-]{2,})/g)) {
    values.push(match[1]);
  }
  return normalizedUnique(values);
}

export function deriveRetrievalRequirements(query: string): RetrievalRequirements {
  const normalized = query.trim();
  const temporal = deriveTemporalRequirement(normalized);
  const negativeTerms = extractNegativeTerms(normalized);
  return {
    intent: deriveIntent(normalized, temporal),
    entities: extractEntities(normalized).filter(
      (entity) => !negativeTerms.some((term) => term.toLowerCase() === entity.toLowerCase()),
    ),
    temporal,
    evidenceRequired: /\b(evidence|citation|source|provenance|verify|prove)\b/i.test(normalized),
    negativeTerms,
  };
}

function sourceRank(source: RetrievalSource): number {
  return SOURCE_ORDER.indexOf(source);
}

function authorityScore(candidate: RetrievedCandidate): number {
  const authority = candidate.authority;
  if (!authority) return 0;
  const explicit = [authority.score, authority.confidence, authority.weight].find(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (explicit !== undefined) return Math.max(0, Math.min(1, explicit));
  switch (authority.source) {
    case "user":
      return 1;
    case "verified_evidence":
      return 0.9;
    case "tool":
      return 0.75;
    case "agent":
      return 0.55;
    case "import":
      return 0.45;
    case "shared":
      return 0.4;
    default:
      return 0;
  }
}

function candidateSort(a: RetrievedCandidate, b: RetrievedCandidate): number {
  // Authority only breaks close relevance ties: user constraints and verified
  // evidence must outrank an equally relevant agent inference, but cannot turn
  // an unrelated result into a top match.
  const scoreDelta =
    b.score + authorityScore(b) * 0.05 - (a.score + authorityScore(a) * 0.05);
  if (scoreDelta) return scoreDelta;
  const timeDelta = compareText(String(b.timestamp ?? ""), String(a.timestamp ?? ""));
  if (timeDelta) return timeDelta;
  return compareText(a.id, b.id);
}

function normalizeCandidate(
  candidate: RetrievedCandidate,
  source: RetrievalSource,
): RetrievedCandidate | null {
  const id = normalizeOptionalString(candidate.id);
  const title = normalizeOptionalString(candidate.title);
  const content = typeof candidate.content === "string" ? candidate.content.trim() : "";
  if (!id || !title || !content) return null;
  const sources = normalizedUnique([
    ...(candidate.sources ?? []),
    ...(candidate.source ? [candidate.source] : []),
    source,
  ]).filter((value): value is RetrievalSource => SOURCE_ORDER.includes(value as RetrievalSource));
  const score = Number.isFinite(candidate.score) ? candidate.score : 0;
  const origin = summarizeRetrievalOrigin(
    candidate.retrievalMetadata?.origin ?? candidate.provenance,
  );
  const evidence = mergeRetrievalEvidence(candidate.retrievalMetadata?.evidence);
  return {
    ...candidate,
    id,
    title,
    content,
    score,
    source,
    sources: sources.sort((a, b) => sourceRank(a) - sourceRank(b)),
    ...(candidate.concepts ? { concepts: normalizedUnique(candidate.concepts) } : {}),
    ...(candidate.sourceObservationIds
      ? { sourceObservationIds: normalizedUnique(candidate.sourceObservationIds) }
      : {}),
    ...(candidate.conflictsWith
      ? { conflictsWith: normalizedUnique(candidate.conflictsWith) }
      : {}),
    retrievalMetadata: origin || evidence
      ? { ...(origin ? { origin } : {}), ...(evidence ? { evidence } : {}) }
      : undefined,
  };
}

function mergeCandidates(candidates: RetrievedCandidate[]): {
  candidates: RetrievedCandidate[];
  duplicateCandidates: number;
} {
  const merged = new Map<string, RetrievedCandidate>();
  let duplicateCandidates = 0;
  for (const candidate of candidates) {
    const existing = merged.get(candidate.id);
    if (!existing) {
      merged.set(candidate.id, candidate);
      continue;
    }
    duplicateCandidates++;
    const winner = candidateSort(candidate, existing) < 0 ? candidate : existing;
    const loser = winner === candidate ? existing : candidate;
    winner.sources = normalizedUnique([
      ...(winner.sources ?? []),
      ...(loser.sources ?? []),
    ]).filter((value): value is RetrievalSource => SOURCE_ORDER.includes(value as RetrievalSource));
    winner.sources.sort((a, b) => sourceRank(a) - sourceRank(b));
    winner.sourceObservationIds = normalizedUnique([
      ...(winner.sourceObservationIds ?? []),
      ...(loser.sourceObservationIds ?? []),
    ]);
    winner.retrievalMetadata = {
      ...(winner.retrievalMetadata?.origin || loser.retrievalMetadata?.origin
        ? { origin: winner.retrievalMetadata?.origin ?? loser.retrievalMetadata?.origin }
        : {}),
      ...(mergeRetrievalEvidence(
        winner.retrievalMetadata?.evidence,
        loser.retrievalMetadata?.evidence,
      )
        ? {
            evidence: mergeRetrievalEvidence(
              winner.retrievalMetadata?.evidence,
              loser.retrievalMetadata?.evidence,
            ),
          }
        : {}),
    };
    winner.conflictsWith = normalizedUnique([
      ...(winner.conflictsWith ?? []),
      ...(loser.conflictsWith ?? []),
    ]);
    merged.set(candidate.id, winner);
  }
  return { candidates: Array.from(merged.values()).sort(candidateSort), duplicateCandidates };
}

function isTemporallyEligible(
  candidate: RetrievedCandidate,
  temporal: TemporalRequirement,
): boolean {
  if (!candidate.timestamp) return true;
  if (temporal.mode === "as_of" && temporal.asOf) {
    return candidate.timestamp <= temporal.asOf;
  }
  if (temporal.mode === "range") {
    if (temporal.from && candidate.timestamp < temporal.from) return false;
    if (temporal.to && candidate.timestamp > temporal.to) return false;
  }
  return true;
}

function matchesRequestedScope(
  candidate: RetrievedCandidate,
  scope: RetrievalScope,
): boolean {
  if (scope.project && candidate.project && candidate.project !== scope.project) {
    return false;
  }
  return !(
    scope.agentId &&
    scope.agentId !== "*" &&
    candidate.agentId &&
    candidate.agentId !== scope.agentId
  );
}

function candidateTier(
  candidate: RetrievedCandidate,
  requirements: RetrievalRequirements,
): ContextTier {
  if (candidate.historical || requirements.temporal.mode === "historical" || requirements.temporal.mode === "as_of") {
    return "historical";
  }
  if (candidate.sources?.every((source) => source === "graph")) {
    return "supporting";
  }
  return "direct";
}

function candidateText(candidate: RetrievedCandidate): string {
  const facts = candidate.concepts?.length ? `\nConcepts: ${candidate.concepts.join(", ")}` : "";
  const graph = candidate.graphContext ? `\nGraph: ${candidate.graphContext}` : "";
  return `${candidate.title}\n${candidate.content}${facts}${graph}`;
}

function candidatePreview(candidate: RetrievedCandidate): string {
  if (candidate.metadata?.kind !== "evidence") {
    return `${candidate.title}\n${candidate.content}`;
  }
  const evidence = candidate.retrievalMetadata?.evidence;
  const references = evidence?.summaries.length
    ? evidence.summaries.map((summary) => {
        const details = [summary.kind, summary.source, summary.locator]
          .filter((value): value is string => Boolean(value))
          .join("; ");
        return details ? `${summary.id}: ${details}` : summary.id;
      })
    : evidence?.ids ?? [];
  return `${candidate.title}\nEvidence reference${references.length === 1 ? "" : "s"}: ${references.join(", ")}`;
}

function provenanceText(candidate: RetrievedCandidate): string | null {
  const parts: string[] = [];
  const origin = candidate.retrievalMetadata?.origin ?? candidate.provenance;
  if (origin?.channel) parts.push(`origin=${origin.channel}`);
  if (origin?.detail) parts.push(`detail=${origin.detail}`);
  if (origin?.capturedAt) parts.push(`capturedAt=${origin.capturedAt}`);
  if (candidate.sourceObservationIds?.length) {
    parts.push(`observations=${candidate.sourceObservationIds.join(",")}`);
  }
  const evidence = candidate.retrievalMetadata?.evidence;
  if (evidence?.ids.length) {
    parts.push(`evidence=${evidence.ids.join(",")}`);
    for (const summary of evidence.summaries) {
      const details = [summary.kind, summary.source, summary.locator]
        .filter((value): value is string => Boolean(value))
        .join("; ");
      if (details) parts.push(`${summary.id}=${details}`);
    }
  }
  if (parts.length === 0) return null;
  return `Provenance for ${candidate.title}: ${parts.join("; ")}`;
}

function contextItemsFor(
  candidates: RetrievedCandidate[],
  requirements: RetrievalRequirements,
): ContextBudgetItem[] {
  const items: ContextBudgetItem[] = [];
  for (const candidate of candidates) {
    items.push({
      id: candidate.id,
      tier: candidateTier(candidate, requirements),
      title: candidate.title,
      text: candidateText(candidate),
         preview: candidatePreview(candidate),
      score: candidate.score,
      source: candidate.sources?.join(","),
         metadata: {
           ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
           ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}),
           ...(candidate.retrievalMetadata ?? {}),
         },
    });
    const provenance = provenanceText(candidate);
    if (provenance && (
      requirements.evidenceRequired ||
      candidate.provenance ||
      candidate.sourceObservationIds?.length ||
      candidate.retrievalMetadata?.evidence?.ids.length
    )) {
      items.push({
        id: `provenance:${candidate.id}`,
        tier: "provenance",
        title: `Provenance: ${candidate.title}`,
        text: provenance,
        score: candidate.score,
        source: candidate.sources?.join(","),
        expandable: false,
         metadata: { candidateId: candidate.id },
      });
    }
  }
  return items;
}

function plannedResult(candidate: RetrievedCandidate): PlannedRetrievalResult {
  return {
    id: candidate.id,
    title: candidate.title,
    score: candidate.score,
    sources: (candidate.sources ?? []).slice(),
    ...(candidate.sessionId ? { sessionId: candidate.sessionId } : {}),
    ...(candidate.timestamp ? { timestamp: candidate.timestamp } : {}),
    ...(candidate.project ? { project: candidate.project } : {}),
    ...(candidate.agentId ? { agentId: candidate.agentId } : {}),
    ...(candidate.historical ? { historical: true } : {}),
    ...(candidate.retrievalMetadata ? { metadata: candidate.retrievalMetadata } : {}),
  };
}

function negativeMatches(
  candidates: RetrievedCandidate[],
  terms: string[],
): NegativeMatch[] {
  if (terms.length === 0) return [];
  return candidates
    .map((candidate) => {
      const text = [candidate.title, candidate.content, ...(candidate.concepts ?? [])]
        .join(" ")
        .toLowerCase();
      const matched = terms.filter((term) => text.includes(term.toLowerCase()));
      return matched.length ? { candidateId: candidate.id, terms: matched } : null;
    })
    .filter((match): match is NegativeMatch => match !== null);
}

function conflictMatches(candidates: RetrievedCandidate[]): ConflictMatch[] {
  const byId = new Map(candidates.map((candidate) => [candidate.id, candidate]));
  const found = new Map<string, ConflictMatch>();
  for (const candidate of candidates) {
    for (const otherId of candidate.conflictsWith ?? []) {
      if (!byId.has(otherId) || otherId === candidate.id) continue;
      const candidateIds = [candidate.id, otherId].sort() as [string, string];
      const key = `explicit:${candidateIds.join(":")}`;
      found.set(key, { candidateIds, reason: "explicit_relation" });
    }
  }
  for (let first = 0; first < candidates.length; first++) {
    for (let second = first + 1; second < candidates.length; second++) {
      const left = candidates[first];
      const right = candidates[second];
      for (const key of Object.keys(left.claims ?? {}).sort()) {
        const leftValue = left.claims?.[key];
        const rightValue = right.claims?.[key];
        if (leftValue === undefined || rightValue === undefined || leftValue === rightValue) continue;
        const candidateIds = [left.id, right.id].sort() as [string, string];
        const conflictKey = `claim:${candidateIds.join(":")}:${key}`;
        found.set(conflictKey, { candidateIds, reason: "claim_value", claim: key });
      }
    }
  }
  return Array.from(found.values()).sort((a, b) => {
    const left = `${a.candidateIds[0]}:${a.candidateIds[1]}:${a.reason}:${a.claim ?? ""}`;
    const right = `${b.candidateIds[0]}:${b.candidateIds[1]}:${b.reason}:${b.claim ?? ""}`;
    return compareText(left, right);
  });
}

export class DeterministicRetrievalPlanner {
  private readonly expansionItems = new WeakMap<RetrievalPlan, ContextBudgetItem[]>();

  constructor(private adapters: RetrievalPlannerAdapters) {}

  async plan(input: RetrievalPlanInput): Promise<RetrievalPlan> {
    const query = normalizeOptionalString(input.query);
    if (!query) throw new Error("retrieval planner: query must be a non-empty string");
    const requirements = deriveRetrievalRequirements(query);
    const project = normalizeOptionalString(input.project);
    const agentId = normalizeOptionalString(input.agentId);
    const scope: RetrievalScope = {
      ...(project ? { project } : {}),
      ...(agentId ? { agentId } : {}),
    };
    const requestedLimit = input.limit ?? 20;
    const limit = Number.isFinite(requestedLimit)
      ? Math.max(1, Math.min(100, Math.floor(requestedLimit)))
      : 20;
    const request: RetrievalRequest = { query, limit, scope, ...requirements };

    const sourceDiagnostics: RetrievalSourceDiagnostic[] = SOURCE_ORDER.map((source) => ({
      source,
      available: Boolean(this.adapters[source]),
      requested: source !== "graph" || requirements.entities.length > 0,
      received: 0,
    }));
    const executions = await Promise.all(
      SOURCE_ORDER.map(async (source) => {
        const adapter = this.adapters[source];
        const diagnostic = sourceDiagnostics.find((entry) => entry.source === source)!;
        if (!adapter || !diagnostic.requested) return [] as RetrievedCandidate[];
        try {
          const candidates = await adapter(request);
          diagnostic.received = candidates.length;
          return candidates
            .map((candidate) => normalizeCandidate(candidate, source))
            .filter((candidate): candidate is RetrievedCandidate => candidate !== null);
        } catch (error) {
          diagnostic.error = error instanceof Error ? error.message : String(error);
          return [] as RetrievedCandidate[];
        }
      }),
    );
    const receivedCandidates = executions.flat();
    const merged = mergeCandidates(receivedCandidates);

    let filteredByProject = 0;
    let filteredByAgent = 0;
    let filteredByTemporal = 0;
    let scopeUnverified = 0;
    const scoped = merged.candidates.filter((candidate) => {
      if (scope.project) {
        if (candidate.project && candidate.project !== scope.project) {
          filteredByProject++;
          return false;
        }
        if (!candidate.project) scopeUnverified++;
      }
      if (scope.agentId && scope.agentId !== "*") {
        if (candidate.agentId && candidate.agentId !== scope.agentId) {
          filteredByAgent++;
          return false;
        }
        if (!candidate.agentId) scopeUnverified++;
      }
      if (!isTemporallyEligible(candidate, requirements.temporal)) {
        filteredByTemporal++;
        return false;
      }
      return true;
    }).slice(0, limit);

    const items = contextItemsFor(scoped, requirements);
    const context = partitionContext(items, {
      ...input.budgets,
      ...(input.tokenBudget !== undefined ? { total: input.tokenBudget } : {}),
    });
    const conflicts = conflictMatches(scoped);
    const plan: RetrievalPlan = {
      query,
      requirements,
      scope,
      results: scoped.map(plannedResult),
      context,
      diagnostics: {
        sources: sourceDiagnostics,
        receivedCandidates: receivedCandidates.length,
        uniqueCandidates: merged.candidates.length,
        duplicateCandidates: merged.duplicateCandidates,
        filteredByProject,
        filteredByAgent,
        filteredByTemporal,
        scopeUnverified,
        negativeMatches: negativeMatches(scoped, requirements.negativeTerms),
        conflicts,
        conflictDetectionAvailable: scoped.some(
          (candidate) => Boolean(candidate.conflictsWith?.length || candidate.claims),
        ),
        budget: context.diagnostics,
      },
    };
    this.expansionItems.set(plan, items);
    return plan;
  }

  expand(
    plan: RetrievalPlan,
    handle: ExpandableContextHandle,
    tokenBudget?: number,
  ): ExpandedContext | null {
    const items = this.expansionItems.get(plan);
    return items ? expandContextHandle(handle, items, tokenBudget) : null;
  }
}

function scoreMemory(memory: Memory, query: string): number {
  const haystack = `${memory.title} ${memory.content} ${memory.concepts.join(" ")}`.toLowerCase();
  const terms = extractKeywords(query);
  const matches = terms.filter((term) => haystack.includes(term.toLowerCase())).length;
  return matches + Math.max(0, memory.strength) / 10;
}

function memoryMatchesQuery(memory: Memory, query: string): boolean {
  const terms = extractKeywords(query);
  if (terms.length === 0) return false;
  const haystack = `${memory.title} ${memory.content} ${memory.concepts.join(" ")}`.toLowerCase();
  return terms.some((term) => haystack.includes(term.toLowerCase()));
}

function observationCandidate(
  observation: CompressedObservation,
  score: number,
  source: RetrievalSource,
  project?: string,
  graphContext?: string,
  retrievalMetadata?: RetrievalResultMetadata,
): RetrievedCandidate {
  return {
    id: observation.id,
    title: observation.title,
    content: observation.narrative,
    score,
    source,
    sessionId: observation.sessionId,
    timestamp: observation.timestamp,
    project,
    agentId: observation.agentId,
    concepts: observation.concepts,
    confidence: observation.confidence,
    importance: observation.importance,
    provenance: observation.origin,
    authority: observation.origin
      ? { source: observation.origin.channel }
      : undefined,
    retrievalMetadata: retrievalMetadata ?? (observation.origin
      ? { origin: summarizeRetrievalOrigin(observation.origin) }
      : undefined),
    graphContext,
  };
}

function memoryCandidate(memory: Memory, score: number): RetrievedCandidate {
  const origin = memory.origin ? summarizeRetrievalOrigin(memory.origin) : undefined;
  const evidence = retrievalEvidenceIds(memory.evidenceIds);
  return {
    id: memory.id,
    title: memory.title,
    content: memory.content,
    score,
    source: "memory",
    sessionId: memory.sessionIds[0],
    timestamp: memory.updatedAt,
    project: memory.project,
    agentId: memory.agentId,
    concepts: memory.concepts,
    historical: !memory.isLatest,
    provenance: memory.origin,
    sourceObservationIds: memory.sourceObservationIds,
    authority: memory.authority,
    retrievalMetadata: origin || evidence
      ? { ...(origin ? { origin } : {}), ...(evidence ? { evidence } : {}) }
      : undefined,
  };
}

function searchResponseCandidates(response: unknown): Array<{
  observation: CompressedObservation;
  score: number;
  sessionId: string;
  metadata?: RetrievalResultMetadata;
}> {
  if (!response || typeof response !== "object" || !Array.isArray((response as { results?: unknown }).results)) {
    return [];
  }
  return (response as { results: unknown[] }).results.filter(
    (entry): entry is {
      observation: CompressedObservation;
      score: number;
      sessionId: string;
      metadata?: RetrievalResultMetadata;
    } =>
      Boolean(
        entry &&
          typeof entry === "object" &&
          "observation" in entry &&
          "score" in entry &&
          "sessionId" in entry,
      ),
  );
}

/**
 * Adapters for a parent that has already registered mem::search and owns the
 * StateKV instance. They deliberately live outside server registration so a
 * caller can decide whether and where to expose the planner.
 */
export function createDefaultRetrievalPlannerAdapters(
  sdk: RetrievalSdk,
  kv: StateKV,
  graphRetrieval = new GraphRetrieval(kv),
): RetrievalPlannerAdapters {
  const sessionProject = async (sessionId: string): Promise<string | undefined> => {
    const session = await kv.get<Session>(KV.sessions, sessionId).catch(() => null);
    return session?.project;
  };
  const hybrid: RetrievalAdapter = async (request) => {
    const response = await sdk.trigger({
      function_id: "mem::search",
      payload: {
        query: request.query,
        limit: request.limit,
        project: request.scope.project,
        agentId: request.scope.agentId,
        format: "full",
      },
    });
    return Promise.all(
      searchResponseCandidates(response).map(async (result) =>
        observationCandidate(
          result.observation,
          result.score,
          "hybrid",
          await sessionProject(result.sessionId),
          undefined,
          result.metadata,
        ),
      ),
    );
  };
  const graph: RetrievalAdapter = async (request) => {
    if (request.entities.length === 0) return [];
    const hits = await graphRetrieval.searchByEntities(request.entities, 2, request.limit);
    const candidates = await Promise.all(
      hits.map(async (hit) => {
        const observation = hit.sessionId
          ? await kv
              .get<CompressedObservation>(KV.observations(hit.sessionId), hit.obsId)
              .catch(() => null)
          : null;
        if (observation) {
          return observationCandidate(
            observation,
            hit.score,
            "graph",
            await sessionProject(observation.sessionId),
            hit.graphContext,
          );
        }
        const memory = await kv.get<Memory>(KV.memories, hit.obsId).catch(() => null);
        return memory ? { ...memoryCandidate(memory, hit.score), graphContext: hit.graphContext } : null;
      }),
    );
    return candidates.filter(
      (candidate): candidate is RetrievedCandidate =>
        candidate !== null && matchesRequestedScope(candidate, request.scope),
    );
  };
  const memory: RetrievalAdapter = async (request) => {
    const [memories, relations] = await Promise.all([
      kv.list<Memory>(KV.memories).catch(() => []),
      kv.list<MemoryRelation>(KV.relations).catch(() => []),
    ]);
    const conflicts = new Map<string, string[]>();
    for (const relation of relations) {
      if (relation.type !== "contradicts") continue;
      const source = conflicts.get(relation.sourceId) ?? [];
      source.push(relation.targetId);
      conflicts.set(relation.sourceId, source);
      const target = conflicts.get(relation.targetId) ?? [];
      target.push(relation.sourceId);
      conflicts.set(relation.targetId, target);
    }
    return Promise.all(memories
      .filter((memory) => memory.isLatest)
      .filter((memory) => memoryMatchesQuery(memory, request.query))
      .map((memory) => ({ memory, score: scoreMemory(memory, request.query) }))
      .filter(({ score }) => score > 0)
      .sort((left, right) => right.score - left.score || compareText(left.memory.id, right.memory.id))
      .slice(0, request.limit)
      .map(async ({ memory, score }) => {
        const candidate = memoryCandidate(memory, score);
        const evidence = await summarizeRetrievalEvidence(kv, memory.evidenceIds, request.scope);
        return {
          ...candidate,
          ...(evidence
            ? {
                retrievalMetadata: {
                  ...(candidate.retrievalMetadata ?? {}),
                  evidence,
                },
              }
            : {}),
          ...(conflicts.has(memory.id)
            ? { conflictsWith: normalizedUnique(conflicts.get(memory.id)!) }
            : {}),
        };
      }))
      .then((candidates) => candidates.filter((candidate) => matchesRequestedScope(candidate, request.scope)));
  };
  return { hybrid, graph, memory };
}
