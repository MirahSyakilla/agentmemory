import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import type { Artifact as DomainArtifact } from "../types.js";
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
  stringArray,
  structuredScope,
  validateScope,
} from "./structured-records.js";
import { reconcileExperimentLinks } from "./experiment-links.js";

export type Artifact = DomainArtifact;

function artifactFields(): string[] {
  return ["name", "kind", "type", "path", "uri", "description", "digest", "hash", "experimentIds", "evidenceIds"];
}

export function registerArtifactFunctions(sdk: ISdk, kv: StateKV): void {
  const write = async (input: unknown) => {
    const data = asRecord(input);
    const name = nonEmptyString(data.name ?? data.title);
    if (!name) return { success: false, error: "name is required" };
    const provenance = provenanceFromInput(data);
    if (provenance.error) return { success: false, error: provenance.error };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    if (data.size !== undefined && (typeof data.size !== "number" || !Number.isFinite(data.size) || data.size < 0)) {
      return { success: false, error: "size must be a non-negative number" };
    }

    const now = new Date().toISOString();
    const kind = nonEmptyString(data.kind ?? data.type) || "file";
    const artifact: Artifact = {
      id: nonEmptyString(data.id) || generateId("art"),
      name,
      kind,
      type: kind,
      path: nonEmptyString(data.path),
      uri: nonEmptyString(data.uri ?? data.url),
      description: nonEmptyString(data.description),
      digest: nonEmptyString(data.digest),
      hash: nonEmptyString(data.hash ?? data.digest),
      size: data.size as number | undefined,
      mediaType: nonEmptyString(data.mediaType ?? data.contentType),
      experimentIds: stringArray(data.experimentIds ?? data.experiments),
      evidenceIds: stringArray(data.evidenceIds ?? data.evidence),
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
      "mem::artifact-write",
      artifact.id,
      artifact,
    );
    if (claim.error) return { success: false, error: claim.error };
    if (claim.replayed) {
      const existing = claim.resourceId
        ? await kv.get<Artifact>(structuredScope("artifacts"), claim.resourceId)
        : null;
      return existing
        ? { success: true, artifact: existing, deduplicated: true }
        : { success: false, error: "idempotent artifact write is still in progress" };
    }
    await kv.set(structuredScope("artifacts"), artifact.id, artifact);
    await reconcileExperimentLinks(kv, { mode: "merge" });
    await completeStructuredWrite(kv, claim);
    await auditWrite(kv, "mem::artifact-write", artifact.id, "artifacts");
    return { success: true, artifact };
  };

  const list = async (input: unknown) => {
    const data = asRecord(input);
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    let records = await kv.list<Artifact>(structuredScope("artifacts"));
    records = records.filter((record) => matchesScope(record, scope.scope));
    const kind = nonEmptyString(data.kind ?? data.type);
    if (kind) records = records.filter((record) => record.kind === kind || record.type === kind);
    records.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
    await auditRead(kv, "mem::artifact-list", "artifacts", records.length);
    return { success: true, artifacts: records.slice(0, parseLimit(data.limit)) };
  };

  const query = async (input: unknown) => {
    const data = asRecord(input);
    const text = nonEmptyString(data.query);
    if (!text) return { success: false, error: "query is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const kind = nonEmptyString(data.kind ?? data.type);
    const records = await kv.list<Artifact>(structuredScope("artifacts"));
    const results = records
      .filter((record) => matchesScope(record, scope.scope))
      .filter((record) => !kind || record.kind === kind || record.type === kind)
      .map((record) => ({ artifact: record, score: scoreText(text, collectText(record, artifactFields())) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.artifact.createdAt.localeCompare(a.artifact.createdAt) || a.artifact.id.localeCompare(b.artifact.id));
    await auditRead(kv, "mem::artifact-query", "artifacts", results.length, text);
    return {
      success: true,
      artifacts: results.slice(0, parseLimit(data.limit)).map((result) => ({ ...result.artifact, score: Math.round(result.score * 1000) / 1000 })),
    };
  };

  const get = async (input: unknown) => {
    const data = asRecord(input);
    const id = nonEmptyString(data.id);
    if (!id) return { success: false, error: "id is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const artifact = await kv.get<Artifact>(structuredScope("artifacts"), id);
    return artifact && matchesScope(artifact, scope.scope)
      ? { success: true, artifact }
      : { success: false, error: "artifact not found" };
  };

  sdk.registerFunction("mem::artifact-write", write);
  sdk.registerFunction("mem::artifact-list", list);
  sdk.registerFunction("mem::artifact-query", query);
  sdk.registerFunction("mem::artifact-get", get);
}
