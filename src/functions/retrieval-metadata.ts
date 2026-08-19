import type {
  Evidence,
  Origin,
  RetrievalEvidenceReference,
  RetrievalEvidenceSummary,
  RetrievalOriginSummary,
  RetrievalResultMetadata,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";

export const MAX_RETRIEVAL_EVIDENCE_REFERENCES = 8;

const MAX_RETRIEVAL_ID_LENGTH = 256;
const MAX_RETRIEVAL_TEXT_LENGTH = 240;
const ORIGIN_CHANNELS = new Set<Origin["channel"]>([
  "user",
  "agent",
  "tool",
  "import",
  "shared",
]);

export interface RetrievalMetadataScope {
  project?: string;
  agentId?: string;
}

interface RetrievalOriginInput {
  channel?: unknown;
  detail?: unknown;
  capturedAt?: unknown;
}

function boundedText(value: unknown): string | undefined {
  if (typeof value !== "string" || !value.trim()) return undefined;
  const trimmed = value.trim();
  return trimmed.length <= MAX_RETRIEVAL_TEXT_LENGTH
    ? trimmed
    : `${trimmed.slice(0, MAX_RETRIEVAL_TEXT_LENGTH - 3)}...`;
}

function boundedIds(values: readonly string[] | undefined): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const value of values ?? []) {
    const id = typeof value === "string" ? value.trim() : "";
    if (!id || id.length > MAX_RETRIEVAL_ID_LENGTH || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
  }
  return result;
}

function scopeMatchesEvidence(
  evidence: Evidence,
  scope: RetrievalMetadataScope,
): boolean {
  if (scope.project && evidence.project !== scope.project) return false;
  if (
    scope.agentId &&
    scope.agentId !== "*" &&
    evidence.agentId !== scope.agentId
  ) return false;
  return true;
}

export function summarizeRetrievalOrigin(
  origin: RetrievalOriginInput | undefined,
): RetrievalOriginSummary | undefined {
  if (!origin || !ORIGIN_CHANNELS.has(origin.channel as Origin["channel"])) {
    return undefined;
  }
  const capturedAt = boundedText(origin.capturedAt);
  if (!capturedAt) return undefined;
  const detail = boundedText(origin.detail);
  return {
    channel: origin.channel as Origin["channel"],
    capturedAt,
    ...(detail ? { detail } : {}),
  };
}

export function summarizeEvidenceReference(
  evidence: Pick<Evidence, "id" | "kind"> &
    Partial<Pick<Evidence, "source" | "locator" | "claim" | "capturedAt" | "verifiedAt" | "verificationMethod">>,
): RetrievalEvidenceReference | undefined {
  const id = boundedIds([evidence.id])[0];
  const kind = boundedText(evidence.kind);
  if (!id || !kind) return undefined;
  const source = boundedText(evidence.source);
  const locator = boundedText(evidence.locator);
  const claim = boundedText(evidence.claim);
  const capturedAt = boundedText(evidence.capturedAt);
  const verifiedAt = boundedText(evidence.verifiedAt);
  const verificationMethod = boundedText(evidence.verificationMethod);
  return {
    id,
    kind,
    ...(source ? { source } : {}),
    ...(locator ? { locator } : {}),
    ...(claim ? { claim } : {}),
    ...(capturedAt ? { capturedAt } : {}),
    ...(verifiedAt ? { verifiedAt } : {}),
    ...(verificationMethod ? { verificationMethod } : {}),
  };
}

export function mergeRetrievalEvidence(
  ...values: Array<RetrievalEvidenceSummary | undefined>
): RetrievalEvidenceSummary | undefined {
  const ids = boundedIds(values.flatMap((value) => value?.ids ?? []));
  const byId = new Map<string, RetrievalEvidenceReference>();
  for (const value of values) {
    for (const summary of value?.summaries ?? []) {
      if (!byId.has(summary.id)) byId.set(summary.id, summary);
    }
  }
  const summaries = ids
    .map((id) => byId.get(id))
    .filter((summary): summary is RetrievalEvidenceReference => summary !== undefined)
    .slice(0, MAX_RETRIEVAL_EVIDENCE_REFERENCES);
  const truncated =
    ids.length > MAX_RETRIEVAL_EVIDENCE_REFERENCES ||
    values.some((value) => value?.truncated === true);
  const visibleIds = ids.slice(0, MAX_RETRIEVAL_EVIDENCE_REFERENCES);
  if (visibleIds.length === 0) return undefined;
  return {
    ids: visibleIds,
    summaries: summaries.filter((summary) => visibleIds.includes(summary.id)),
    ...(truncated ? { truncated: true } : {}),
  };
}

export function retrievalEvidenceIds(
  evidenceIds: readonly string[] | undefined,
): RetrievalEvidenceSummary | undefined {
  const allIds = boundedIds(evidenceIds);
  const ids = allIds.slice(0, MAX_RETRIEVAL_EVIDENCE_REFERENCES);
  if (ids.length === 0) return undefined;
  return {
    ids,
    summaries: [],
    ...(allIds.length > ids.length ? { truncated: true } : {}),
  };
}

export async function summarizeRetrievalEvidence(
  kv: StateKV,
  evidenceIds: readonly string[] | undefined,
  scope: RetrievalMetadataScope = {},
): Promise<RetrievalEvidenceSummary | undefined> {
  const ids = boundedIds(evidenceIds);
  if (ids.length === 0) return undefined;
  const selected = ids.slice(0, MAX_RETRIEVAL_EVIDENCE_REFERENCES);
  const records = await Promise.all(
    selected.map((id) => kv.get<Evidence>(KV.evidence, id).catch(() => null)),
  );
  const visibleIds: string[] = [];
  const summaries: RetrievalEvidenceReference[] = [];
  for (let index = 0; index < selected.length; index++) {
    const evidence = records[index];
    if (evidence && !scopeMatchesEvidence(evidence, scope)) continue;
    visibleIds.push(selected[index]);
    if (evidence) {
      const summary = summarizeEvidenceReference(evidence);
      if (summary) summaries.push(summary);
    }
  }
  if (visibleIds.length === 0) return undefined;
  return {
    ids: visibleIds,
    summaries,
    ...(ids.length > selected.length || visibleIds.length < selected.length
      ? { truncated: true }
      : {}),
  };
}

export async function retrievalResultMetadata(
  kv: StateKV,
  input: {
    origin?: RetrievalOriginInput;
    evidenceIds?: readonly string[];
    scope?: RetrievalMetadataScope;
  },
): Promise<RetrievalResultMetadata | undefined> {
  const [origin, evidence] = await Promise.all([
    Promise.resolve(summarizeRetrievalOrigin(input.origin)),
    summarizeRetrievalEvidence(kv, input.evidenceIds, input.scope),
  ]);
  if (!origin && !evidence) return undefined;
  return {
    ...(origin ? { origin } : {}),
    ...(evidence ? { evidence } : {}),
  };
}
