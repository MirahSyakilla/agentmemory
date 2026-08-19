import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";
import type { EvidenceProvenance, RequestLedgerEntry } from "../types.js";
import { safeAudit } from "./audit.js";

export type StructuredDomain =
  | "evidence"
  | "artifacts"
  | "experiments"
  | "negativeMemories";

export interface StructuredScope {
  project?: string;
  agentId?: string;
}

export interface RecordProvenance extends EvidenceProvenance {
  [key: string]: unknown;
}

export interface StructuredRecordBase extends StructuredScope {
  id: string;
  createdAt: string;
  updatedAt?: string;
  provenance: RecordProvenance;
}

const FALLBACK_SCOPES: Record<StructuredDomain, string> = {
  evidence: "mem:evidence",
  artifacts: "mem:artifacts",
  experiments: "mem:experiments",
  negativeMemories: "mem:negative-memories",
};

export function structuredScope(domain: StructuredDomain): string {
  const configured = (KV as unknown as Record<string, unknown>)[domain];
  return typeof configured === "string" ? configured : FALLBACK_SCOPES[domain];
}

export function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

export function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function stringArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.filter((item): item is string => typeof item === "string").map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(",").map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

export function unknownArray(value: unknown): unknown[] {
  return Array.isArray(value) ? [...value] : [];
}

function isValidTimestamp(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && Number.isFinite(Date.parse(value));
}

export function validateProvenance(
  value: unknown,
): { value?: RecordProvenance; error?: string } {
  const provenance = asRecord(value);
  if (Object.keys(provenance).length === 0) {
    return { error: "provenance is required" };
  }

  const channels = ["user", "agent", "tool", "import", "shared"] as const;
  if (!channels.includes(provenance.channel as (typeof channels)[number])) {
    return { error: "provenance.channel must be one of: user, agent, tool, import, shared" };
  }
  if (!isValidTimestamp(provenance.capturedAt)) {
    return { error: "provenance.capturedAt must be a valid timestamp" };
  }

  for (const field of ["detail", "source", "sourceId", "sourceType"]) {
    if (provenance[field] !== undefined && typeof provenance[field] !== "string") {
      return { error: `provenance.${field} must be a string` };
    }
  }

  return { value: { ...provenance, channel: provenance.channel as RecordProvenance["channel"], capturedAt: provenance.capturedAt } };
}

export function provenanceFromInput(data: Record<string, unknown>): { value?: RecordProvenance; error?: string } {
  return validateProvenance(data.provenance ?? data.origin);
}

export function validateScope(data: Record<string, unknown>): { scope: StructuredScope; error?: string } {
  const scope: StructuredScope = {};
  for (const field of ["project", "agentId"] as const) {
    const value = data[field];
    if (value === undefined) continue;
    if (typeof value !== "string" || !value.trim()) {
      return { scope, error: `${field} must be a non-empty string when provided` };
    }
    scope[field] = value.trim();
  }
  return { scope };
}

export function matchesScope(record: StructuredScope, filter: StructuredScope): boolean {
  return (filter.project === undefined || record.project === filter.project) &&
    (filter.agentId === undefined || filter.agentId === "*" || record.agentId === filter.agentId);
}

export function parseLimit(value: unknown, fallback = 50): number {
  if (typeof value !== "number" || !Number.isInteger(value) || value <= 0) return fallback;
  return Math.min(value, 500);
}

export function normalizeSearch(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

export function searchTokens(value: string): string[] {
  return [...new Set(normalizeSearch(value).split(/\s+/).filter((token) => token.length > 1))];
}

export function scoreText(query: string, text: string): number {
  const normalizedQuery = normalizeSearch(query);
  const normalizedText = normalizeSearch(text);
  if (!normalizedQuery || !normalizedText) return 0;
  if (normalizedQuery === normalizedText) return 1;
  if (normalizedText.includes(normalizedQuery)) return 0.9;
  const queryTokens = searchTokens(normalizedQuery);
  const textTokens = new Set(searchTokens(normalizedText));
  if (queryTokens.length === 0) return 0;
  const overlap = queryTokens.filter((token) => textTokens.has(token)).length / queryTokens.length;
  return overlap > 0 ? 0.25 + overlap * 0.65 : 0;
}

export function collectText(record: unknown, fields: string[]): string {
  const value = asRecord(record);
  return fields.flatMap((field) => {
    const fieldValue = value[field];
    if (typeof fieldValue === "string") return [fieldValue];
    if (Array.isArray(fieldValue)) return fieldValue.filter((item): item is string => typeof item === "string");
    return [];
  }).join(" ");
}

export function validOptionalDate(value: unknown, field: string): { value?: string; error?: string } {
  if (value === undefined || value === null || value === "") return {};
  if (!isValidTimestamp(value)) return { error: `${field} must be a valid timestamp` };
  return { value };
}

export interface IdempotentWriteClaim {
  replayed: boolean;
  resourceId?: string;
  ledgerKey?: string;
  error?: string;
}

function idempotencyKey(data: Record<string, unknown>): { value?: string; error?: string } {
  const raw = data.idempotencyKey ?? data.requestId ?? data.fingerprint;
  if (raw === undefined) return {};
  if (typeof raw !== "string" || !raw.trim()) {
    return { error: "idempotencyKey, requestId, or fingerprint must be a non-empty string" };
  }
  const value = raw.trim();
  if (value.length > 256) return { error: "idempotency key must be at most 256 characters" };
  return { value };
}

export async function claimStructuredWrite(
  kv: StateKV,
  data: Record<string, unknown>,
  operation: string,
  resourceId: string,
  scope: StructuredScope,
): Promise<IdempotentWriteClaim> {
  const keyResult = idempotencyKey(data);
  if (keyResult.error) return { replayed: false, error: keyResult.error };
  if (!keyResult.value) return { replayed: false };
  const ledgerKey = [operation, scope.project ?? "", scope.agentId ?? "", keyResult.value].join(":");
  const createdAt = new Date().toISOString();
  const entry: RequestLedgerEntry = {
    id: ledgerKey,
    operation,
    resourceId,
    status: "claimed",
    createdAt,
    ...(scope.project ? { project: scope.project } : {}),
    ...(scope.agentId ? { agentId: scope.agentId } : {}),
  };
  try {
    const claim = await kv.claim<RequestLedgerEntry>(KV.requestLedger, ledgerKey, entry);
    return claim.claimed
      ? { replayed: false, ledgerKey }
      : { replayed: true, resourceId: claim.value?.resourceId, ledgerKey };
  } catch (error) {
    return {
      replayed: false,
      error:
        "durable idempotency requires the PostgreSQL metadata backend: " +
        (error instanceof Error ? error.message : String(error)),
    };
  }
}

export async function completeStructuredWrite(
  kv: StateKV,
  claim: IdempotentWriteClaim,
): Promise<void> {
  if (!claim.ledgerKey) return;
  const entry = await kv.get<RequestLedgerEntry>(KV.requestLedger, claim.ledgerKey);
  if (!entry) return;
  const completedAt = new Date().toISOString();
  await kv.set(KV.requestLedger, claim.ledgerKey, {
    ...entry,
    status: "completed",
    completedAt,
  } satisfies RequestLedgerEntry);
}

export async function auditWrite(
  kv: StateKV,
  functionId: string,
  id: string,
  domain: StructuredDomain,
): Promise<void> {
  const operation = {
    evidence: "evidence_write",
    artifacts: "artifact_write",
    experiments: "experiment_write",
    negativeMemories: "negative_memory_write",
  } as const;
  await safeAudit(kv, operation[domain], functionId, [id], { domain, action: "write" });
}

export async function auditRead(
  kv: StateKV,
  functionId: string,
  domain: StructuredDomain,
  resultCount: number,
  query?: string,
): Promise<void> {
  await safeAudit(kv, "observe", functionId, [], { domain, action: "read", resultCount, ...(query ? { query } : {}) });
}
