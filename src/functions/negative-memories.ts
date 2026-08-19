import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import type { NegativeMemory as DomainNegativeMemory } from "../types.js";
import { generateId } from "../state/schema.js";
import {
  asRecord,
  auditRead,
  auditWrite,
  claimStructuredWrite,
  collectText,
  completeStructuredWrite,
  matchesScope,
  nonEmptyString,
  normalizeSearch,
  parseLimit,
  provenanceFromInput,
  scoreText,
  stringArray,
  structuredScope,
  validateScope,
  validOptionalDate,
} from "./structured-records.js";
import { reconcileExperimentLinks } from "./experiment-links.js";

export type NegativeMemory = DomainNegativeMemory;

function negativeFields(): string[] {
  return ["approach", "statement", "reason", "outcome", "experimentIds", "evidenceIds", "environment", "sourceRevision"];
}

function scopeMatchesNegative(record: NegativeMemory, data: Record<string, unknown>): boolean {
  const scope = validateScope(data);
  if (scope.error || !matchesScope(record, scope.scope)) return false;
  if (data.includeSuperseded !== true && record.status === "superseded") return false;
  if (data.status !== undefined && record.status !== data.status) return false;
  if (data.environment !== undefined && record.environment !== data.environment) return false;
  if (data.sourceRevision !== undefined && record.sourceRevision !== data.sourceRevision) return false;
  const asOf = data.asOf;
  if (asOf !== undefined) {
    if (typeof asOf !== "string" || !Number.isFinite(Date.parse(asOf))) return false;
    const timestamp = Date.parse(asOf);
    if (record.validFrom && Date.parse(record.validFrom) > timestamp) return false;
    if (record.validUntil && Date.parse(record.validUntil) < timestamp) return false;
  }
  if (data.asOf === undefined && data.includeExpired !== true && record.validUntil && Date.parse(record.validUntil) < Date.now()) return false;
  return true;
}

function validConfidence(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.min(1, value)) : 0.8;
}

export function registerNegativeMemoryFunctions(sdk: ISdk, kv: StateKV): void {
  const write = async (input: unknown) => {
    const data = asRecord(input);
    const approach = nonEmptyString(data.approach ?? data.failedApproach ?? data.action ?? data.method);
    if (!approach) return { success: false, error: "approach is required" };
    const reason = nonEmptyString(data.reason ?? data.outcome ?? data.failure ?? data.failureMode);
    if (!reason) return { success: false, error: "reason or outcome is required" };
    const provenance = provenanceFromInput(data);
    if (provenance.error) return { success: false, error: provenance.error };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const validFrom = validOptionalDate(data.validFrom, "validFrom");
    if (validFrom.error) return { success: false, error: validFrom.error };
    const validUntil = validOptionalDate(data.validUntil, "validUntil");
    if (validUntil.error) return { success: false, error: validUntil.error };
    if (validFrom.value && validUntil.value && Date.parse(validFrom.value) > Date.parse(validUntil.value)) {
      return { success: false, error: "validFrom must not be after validUntil" };
    }
    const statuses = ["failed", "invalid", "disproven", "superseded"] as const;
    const status = data.status === undefined ? "failed" : data.status;
    if (!statuses.includes(status as (typeof statuses)[number])) return { success: false, error: "status must be one of: failed, invalid, disproven, superseded" };
    const now = new Date().toISOString();
    const statement = nonEmptyString(data.statement) || `${approach}: ${reason}`;
    const negative: NegativeMemory = {
      id: nonEmptyString(data.id) || generateId("neg"),
      approach,
      statement,
      reason,
      outcome: nonEmptyString(data.outcome),
      status: status as NegativeMemory["status"],
      experimentIds: stringArray(data.experimentIds ?? data.experimentId ?? data.experiments),
      evidenceIds: stringArray(data.evidenceIds ?? data.evidenceId ?? data.evidence),
      environment: nonEmptyString(data.environment),
      sourceRevision: nonEmptyString(data.sourceRevision ?? data.revision),
      validFrom: validFrom.value,
      validUntil: validUntil.value,
      confidence: validConfidence(data.confidence),
      provenance: provenance.value!,
      createdAt: now,
      updatedAt: now,
      metadata: data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
        ? { ...(data.metadata as Record<string, unknown>) }
        : undefined,
      ...scope.scope,
    };
    const claim = await claimStructuredWrite(
      kv,
      data,
      "mem::negative-memory-write",
      negative.id,
      negative,
    );
    if (claim.error) return { success: false, error: claim.error };
    if (claim.replayed) {
      const existing = claim.resourceId
        ? await kv.get<NegativeMemory>(structuredScope("negativeMemories"), claim.resourceId)
        : null;
      return existing
        ? { success: true, negativeMemory: existing, deduplicated: true }
        : { success: false, error: "idempotent negative-memory write is still in progress" };
    }
    await kv.set(structuredScope("negativeMemories"), negative.id, negative);
    await reconcileExperimentLinks(kv, { mode: "merge" });
    await completeStructuredWrite(kv, claim);
    await auditWrite(kv, "mem::negative-memory-write", negative.id, "negativeMemories");
    return { success: true, negativeMemory: negative };
  };

  const list = async (input: unknown) => {
    const data = asRecord(input);
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    if (data.status !== undefined && !["failed", "invalid", "disproven", "superseded"].includes(data.status as string)) {
      return { success: false, error: "status must be one of: failed, invalid, disproven, superseded" };
    }
    let records = await kv.list<NegativeMemory>(structuredScope("negativeMemories"));
    records = records.filter((record) => scopeMatchesNegative(record, data));
    records.sort((a, b) => b.confidence - a.confidence || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    await auditRead(kv, "mem::negative-memory-list", "negativeMemories", records.length);
    return { success: true, negativeMemories: records.slice(0, parseLimit(data.limit)) };
  };

  const lookup = async (input: unknown) => {
    const data = asRecord(input);
    const query = nonEmptyString(data.query ?? data.approach ?? data.statement);
    if (!query) return { success: false, error: "query or approach is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    if (data.environment !== undefined && typeof data.environment !== "string") {
      return { success: false, error: "environment must be a string when provided" };
    }
    if (data.sourceRevision !== undefined && typeof data.sourceRevision !== "string") {
      return { success: false, error: "sourceRevision must be a string when provided" };
    }
    if (data.status !== undefined && !["failed", "invalid", "disproven", "superseded"].includes(data.status as string)) {
      return { success: false, error: "status must be one of: failed, invalid, disproven, superseded" };
    }
    if (data.asOf !== undefined && (typeof data.asOf !== "string" || !Number.isFinite(Date.parse(data.asOf)))) {
      return { success: false, error: "asOf must be a valid timestamp" };
    }
    const records = await kv.list<NegativeMemory>(structuredScope("negativeMemories"));
    const normalizedQuery = normalizeSearch(query);
    const results = records
      .filter((record) => scopeMatchesNegative(record, data))
      .map((record) => {
        const searchable = collectText(record, negativeFields());
        const exactApproach = normalizeSearch(record.approach) === normalizedQuery;
        const score = exactApproach ? 1 : scoreText(query, searchable) * record.confidence;
        return { negativeMemory: record, score };
      })
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.negativeMemory.confidence - a.negativeMemory.confidence || b.negativeMemory.updatedAt.localeCompare(a.negativeMemory.updatedAt) || a.negativeMemory.id.localeCompare(b.negativeMemory.id));
    await auditRead(kv, "mem::negative-memory-lookup", "negativeMemories", results.length, query);
    return {
      success: true,
      negativeMemories: results.slice(0, parseLimit(data.limit, 10)).map((result) => ({ ...result.negativeMemory, score: Math.round(result.score * 1000) / 1000 })),
      shouldNotRetry: results.length > 0,
    };
  };

  const get = async (input: unknown) => {
    const data = asRecord(input);
    const id = nonEmptyString(data.id);
    if (!id) return { success: false, error: "id is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const negativeMemory = await kv.get<NegativeMemory>(structuredScope("negativeMemories"), id);
    return negativeMemory && matchesScope(negativeMemory, scope.scope)
      ? { success: true, negativeMemory }
      : { success: false, error: "negative memory not found" };
  };

  sdk.registerFunction("mem::negative-memory-write", write);
  sdk.registerFunction("mem::negative-memory-list", list);
  sdk.registerFunction("mem::negative-memory-lookup", lookup);
  sdk.registerFunction("mem::negative-memory-get", get);
}
