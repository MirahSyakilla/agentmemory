import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import type { Evidence as DomainEvidence } from "../types.js";
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
  parseLimit,
  provenanceFromInput,
  scoreText,
  structuredScope,
  validateScope,
  validOptionalDate,
  stringArray,
} from "./structured-records.js";
import { reconcileExperimentLinks } from "./experiment-links.js";

export type Evidence = DomainEvidence;

function evidenceFields(): string[] {
  return ["kind", "type", "source", "locator", "content", "claim", "artifactId", "experimentId", "sourceIds"];
}

export function registerEvidenceFunctions(sdk: ISdk, kv: StateKV): void {
  const write = async (input: unknown) => {
    const data = asRecord(input);
    const kind = nonEmptyString(data.kind ?? data.type);
    if (!kind) return { success: false, error: "kind or type is required" };
    const provenance = provenanceFromInput(data);
    if (provenance.error) return { success: false, error: provenance.error };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const verifiedAt = validOptionalDate(data.verifiedAt, "verifiedAt");
    if (verifiedAt.error) return { success: false, error: verifiedAt.error };

    const now = new Date().toISOString();
    const evidence: Evidence = {
      id: nonEmptyString(data.id) || generateId("evd"),
      kind,
      type: kind,
      source: nonEmptyString(data.source ?? data.sourceRef ?? data.ref),
      locator: nonEmptyString(data.locator ?? data.path ?? data.url ?? data.reference),
      content: nonEmptyString(data.content ?? data.text),
      claim: nonEmptyString(data.claim),
      artifactId: nonEmptyString(data.artifactId),
      experimentId: nonEmptyString(data.experimentId),
      sourceIds: stringArray(data.sourceIds),
      provenance: provenance.value!,
      capturedAt: provenance.value!.capturedAt,
      createdAt: now,
      updatedAt: now,
      verifiedAt: verifiedAt.value,
      verifier: nonEmptyString(data.verifier),
      verificationMethod: nonEmptyString(data.verificationMethod),
      metadata: data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
        ? { ...(data.metadata as Record<string, unknown>) }
        : undefined,
      ...scope.scope,
    };
    const claim = await claimStructuredWrite(
      kv,
      data,
      "mem::evidence-write",
      evidence.id,
      evidence,
    );
    if (claim.error) return { success: false, error: claim.error };
    if (claim.replayed) {
      const existing = claim.resourceId
        ? await kv.get<Evidence>(structuredScope("evidence"), claim.resourceId)
        : null;
      return existing
        ? { success: true, evidence: existing, deduplicated: true }
        : { success: false, error: "idempotent evidence write is still in progress" };
    }
    await kv.set(structuredScope("evidence"), evidence.id, evidence);
    await reconcileExperimentLinks(kv, { mode: "merge" });
    await completeStructuredWrite(kv, claim);
    await auditWrite(kv, "mem::evidence-write", evidence.id, "evidence");
    return { success: true, evidence };
  };

  const list = async (input: unknown) => {
    const data = asRecord(input);
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    let records = await kv.list<Evidence>(structuredScope("evidence"));
    records = records.filter((record) => matchesScope(record, scope.scope));
    const kind = nonEmptyString(data.kind ?? data.type);
    if (kind) records = records.filter((record) => record.kind === kind || record.type === kind);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    await auditRead(kv, "mem::evidence-list", "evidence", records.length);
    return { success: true, evidence: records.slice(0, parseLimit(data.limit)) };
  };

  const query = async (input: unknown) => {
    const data = asRecord(input);
    const text = nonEmptyString(data.query);
    if (!text) return { success: false, error: "query is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    let records = await kv.list<Evidence>(structuredScope("evidence"));
    const kind = nonEmptyString(data.kind ?? data.type);
    const results = records
      .filter((record) => matchesScope(record, scope.scope))
      .filter((record) => !kind || record.kind === kind || record.type === kind)
      .map((record) => ({ evidence: record, score: scoreText(text, collectText(record, evidenceFields())) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.evidence.createdAt.localeCompare(a.evidence.createdAt) || a.evidence.id.localeCompare(b.evidence.id));
    await auditRead(kv, "mem::evidence-query", "evidence", results.length, text);
    return {
      success: true,
      evidence: results.slice(0, parseLimit(data.limit)).map((result) => ({ ...result.evidence, score: Math.round(result.score * 1000) / 1000 })),
    };
  };

  const get = async (input: unknown) => {
    const data = asRecord(input);
    const id = nonEmptyString(data.id);
    if (!id) return { success: false, error: "id is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const evidence = await kv.get<Evidence>(structuredScope("evidence"), id);
    return evidence && matchesScope(evidence, scope.scope)
      ? { success: true, evidence }
      : { success: false, error: "evidence not found" };
  };

  const verify = async (input: unknown) => {
    const data = asRecord(input);
    const id = nonEmptyString(data.id ?? data.evidenceId);
    if (!id) return { success: false, error: "id or evidenceId is required" };
    const verifier = nonEmptyString(data.verifier);
    if (!verifier) return { success: false, error: "verifier is required" };
    const verificationMethod = nonEmptyString(data.verificationMethod ?? data.method);
    if (!verificationMethod) {
      return { success: false, error: "verificationMethod or method is required" };
    }
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const verifiedAt = validOptionalDate(data.verifiedAt, "verifiedAt");
    if (verifiedAt.error) return { success: false, error: verifiedAt.error };
    const evidence = await kv.get<Evidence>(structuredScope("evidence"), id);
    if (!evidence || !matchesScope(evidence, scope.scope)) {
      return { success: false, error: "evidence not found" };
    }
    const now = new Date().toISOString();
    const updated: Evidence = {
      ...evidence,
      verifier,
      verificationMethod,
      verifiedAt: verifiedAt.value ?? now,
      updatedAt: now,
      ...(data.result !== undefined
        ? {
            metadata: {
              ...(evidence.metadata ?? {}),
              verificationResult: data.result,
            },
          }
        : {}),
    };
    await kv.set(structuredScope("evidence"), updated.id, updated);
    await auditWrite(kv, "mem::evidence-verify", updated.id, "evidence");
    return { success: true, evidence: updated };
  };

  sdk.registerFunction("mem::evidence-write", write);
  sdk.registerFunction("mem::evidence-list", list);
  sdk.registerFunction("mem::evidence-query", query);
  sdk.registerFunction("mem::evidence-get", get);
  sdk.registerFunction("mem::evidence-verify", verify);
}
