import type { ISdk } from "iii-sdk";
import type { StateKV } from "../state/kv.js";
import type {
  Action,
  CompressedObservation,
  Experiment as DomainExperiment,
  ExperimentStatus as DomainExperimentStatus,
  GraphNode,
  NegativeMemory,
  Session,
} from "../types.js";
import { KV, generateId } from "../state/schema.js";
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
  unknownArray,
  validateScope,
  validOptionalDate,
} from "./structured-records.js";
import { reconcileExperimentLinks } from "./experiment-links.js";

export type ExperimentStatus = DomainExperimentStatus;
export type Experiment = DomainExperiment;

function experimentFields(): string[] {
  return ["title", "objective", "hypothesis", "environment", "sourceRevision", "revision", "toolchain", "commands", "artifactIds", "artifacts", "observationIds", "evidenceIds", "actionIds", "sessionIds", "graphNodeIds", "negativeMemoryIds", "observations", "result", "conclusion", "followUp"];
}

function validateStatus(value: unknown): { value: ExperimentStatus; error?: string } {
  if (value === undefined) return { value: "planned" };
  const statuses: ExperimentStatus[] = ["planned", "running", "completed", "failed", "cancelled"];
  if (!statuses.includes(value as ExperimentStatus)) return { value: "planned", error: `status must be one of: ${statuses.join(", ")}` };
  return { value: value as ExperimentStatus };
}

function buildExperiment(data: Record<string, unknown>, existing?: Experiment): { value?: Experiment; error?: string } {
  const objective = nonEmptyString(data.objective) || existing?.objective;
  if (!objective) return { error: "objective is required" };
  const provenance: { value?: Experiment["provenance"]; error?: string } =
    data.provenance === undefined && data.origin === undefined && existing
      ? { value: existing.provenance }
      : provenanceFromInput(data);
  if (provenance.error) return { error: provenance.error };
  const scope = validateScope(data);
  if (scope.error) return { error: scope.error };
  const status = validateStatus(data.status ?? existing?.status);
  if (status.error) return { error: status.error };
  const startedAt = validOptionalDate(data.startedAt, "startedAt");
  if (startedAt.error) return { error: startedAt.error };
  const completedAt = validOptionalDate(data.completedAt, "completedAt");
  if (completedAt.error) return { error: completedAt.error };
  const now = new Date().toISOString();
  const artifactIds = stringArray(data.artifactIds ?? data.artifacts ?? existing?.artifactIds);
  const observationIds = stringArray(data.observationIds ?? data.observations ?? existing?.observationIds);
  const evidenceIds = stringArray(data.evidenceIds ?? data.evidence ?? existing?.evidenceIds);
  const actionIds = stringArray(data.actionIds ?? data.actions ?? existing?.actionIds);
  const sessionIds = stringArray(data.sessionIds ?? data.sessions ?? existing?.sessionIds);
  const graphNodeIds = stringArray(data.graphNodeIds ?? data.graphNodes ?? existing?.graphNodeIds);
  const negativeMemoryIds = stringArray(data.negativeMemoryIds ?? data.negativeMemories ?? existing?.negativeMemoryIds);
  return {
    value: {
      ...existing,
      id: existing?.id || nonEmptyString(data.id) || generateId("exp"),
      title: nonEmptyString(data.title) ?? existing?.title,
      objective,
      hypothesis: nonEmptyString(data.hypothesis) ?? existing?.hypothesis,
      environment: nonEmptyString(data.environment) ?? existing?.environment,
      sourceRevision: nonEmptyString(data.sourceRevision ?? data.revision) ?? existing?.sourceRevision,
      revision: nonEmptyString(data.revision ?? data.sourceRevision) ?? existing?.revision,
      toolchain: nonEmptyString(data.toolchain) ?? existing?.toolchain,
      commands: data.commands === undefined && existing ? existing.commands : stringArray(data.commands),
      inputs: data.inputs === undefined && existing ? existing.inputs : unknownArray(data.inputs),
      artifactIds,
      artifacts: [...artifactIds],
      observationIds,
      evidenceIds,
      actionIds,
      sessionIds,
      graphNodeIds,
      negativeMemoryIds,
      authority: data.authority && typeof data.authority === "object" && !Array.isArray(data.authority)
        ? { ...(data.authority as NonNullable<Experiment["authority"]>) }
        : existing?.authority,
      observations: [...observationIds],
      result: data.result !== undefined ? data.result : existing?.result,
      conclusion: nonEmptyString(data.conclusion) ?? existing?.conclusion,
      followUp: data.followUp === undefined && existing ? existing.followUp : stringArray(data.followUp ?? data.followUpLinks),
      status: status.value,
      provenance: provenance.value!,
      createdAt: existing?.createdAt || now,
      updatedAt: now,
      startedAt: startedAt.value ?? existing?.startedAt,
      completedAt: completedAt.value ?? existing?.completedAt,
      metadata: data.metadata === undefined && existing ? existing.metadata : data.metadata && typeof data.metadata === "object" && !Array.isArray(data.metadata)
        ? { ...(data.metadata as Record<string, unknown>) }
        : undefined,
      ...scope.scope,
    },
  };
}

export function registerExperimentFunctions(sdk: ISdk, kv: StateKV): void {
  const write = async (input: unknown) => {
    const built = buildExperiment(asRecord(input));
    if (built.error) return { success: false, error: built.error };
    const experiment = built.value!;
    const claim = await claimStructuredWrite(
      kv,
      asRecord(input),
      "mem::experiment-create",
      experiment.id,
      experiment,
    );
    if (claim.error) return { success: false, error: claim.error };
    if (claim.replayed) {
      const existing = claim.resourceId
        ? await kv.get<Experiment>(structuredScope("experiments"), claim.resourceId)
        : null;
      return existing
        ? { success: true, experiment: existing, deduplicated: true }
        : { success: false, error: "idempotent experiment write is still in progress" };
    }
    await kv.set(structuredScope("experiments"), experiment.id, experiment);
    const reconciliation = await reconcileExperimentLinks(kv, {
      experimentIds: [experiment.id],
      mode: "experiment",
    });
    const reconciled = reconciliation.experiments[0] ?? experiment;
    await completeStructuredWrite(kv, claim);
    await auditWrite(kv, "mem::experiment-create", experiment.id, "experiments");
    return { success: true, experiment: reconciled };
  };

  const update = async (input: unknown) => {
    const data = asRecord(input);
    const id = nonEmptyString(data.id ?? data.experimentId);
    if (!id) return { success: false, error: "id or experimentId is required" };
    const existing = await kv.get<Experiment>(structuredScope("experiments"), id);
    if (!existing) return { success: false, error: "experiment not found" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    if (!matchesScope(existing, scope.scope)) return { success: false, error: "experiment not found" };
    const built = buildExperiment({ ...data, id }, existing);
    if (built.error) return { success: false, error: built.error };
    const experiment = built.value!;
    await kv.set(structuredScope("experiments"), id, experiment);
    const reconciliation = await reconcileExperimentLinks(kv, {
      experimentIds: [id],
      mode: "experiment",
    });
    const reconciled = reconciliation.experiments[0] ?? experiment;
    await auditWrite(kv, "mem::experiment-update", experiment.id, "experiments");
    return { success: true, experiment: reconciled };
  };

  const get = async (input: unknown) => {
    const data = asRecord(input);
    const id = nonEmptyString(data.id ?? data.experimentId);
    if (!id) return { success: false, error: "id or experimentId is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const experiment = await kv.get<Experiment>(structuredScope("experiments"), id);
    return experiment && matchesScope(experiment, scope.scope)
      ? { success: true, experiment }
      : { success: false, error: "experiment not found" };
  };

  const list = async (input: unknown) => {
    const data = asRecord(input);
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const status = nonEmptyString(data.status);
    let records = await kv.list<Experiment>(structuredScope("experiments"));
    records = records.filter((record) => matchesScope(record, scope.scope)).filter((record) => !status || record.status === status);
    records.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id));
    await auditRead(kv, "mem::experiment-list", "experiments", records.length);
    return { success: true, experiments: records.slice(0, parseLimit(data.limit)) };
  };

  const query = async (input: unknown) => {
    const data = asRecord(input);
    const text = nonEmptyString(data.query);
    if (!text) return { success: false, error: "query is required" };
    const scope = validateScope(data);
    if (scope.error) return { success: false, error: scope.error };
    const status = nonEmptyString(data.status);
    const records = await kv.list<Experiment>(structuredScope("experiments"));
    const results = records
      .filter((record) => matchesScope(record, scope.scope))
      .filter((record) => !status || record.status === status)
      .map((record) => ({ experiment: record, score: scoreText(text, collectText(record, experimentFields())) }))
      .filter((result) => result.score > 0)
      .sort((a, b) => b.score - a.score || b.experiment.updatedAt.localeCompare(a.experiment.updatedAt) || a.experiment.id.localeCompare(b.experiment.id));
    await auditRead(kv, "mem::experiment-query", "experiments", results.length, text);
    return {
      success: true,
      experiments: results.slice(0, parseLimit(data.limit)).map((result) => ({ ...result.experiment, score: Math.round(result.score * 1000) / 1000 })),
    };
  };

  const expand = async (input: unknown) => {
    const result = await get(input);
    if (!result.success) return result;
    const experiment = result.experiment!;
    const [artifacts, evidence, actions, sessions, graphNodes, negativeMemories] = await Promise.all([
      Promise.all(experiment.artifactIds.map((id) => kv.get(structuredScope("artifacts"), id))),
      Promise.all(experiment.evidenceIds.map((id) => kv.get(structuredScope("evidence"), id))),
      Promise.all((experiment.actionIds ?? []).map((id) => kv.get<Action>(KV.actions, id))),
      kv.list<Session>(KV.sessions),
      Promise.all((experiment.graphNodeIds ?? []).map((id) => kv.get<GraphNode>(KV.graphNodes, id))),
      Promise.all((experiment.negativeMemoryIds ?? []).map((id) => kv.get<NegativeMemory>(structuredScope("negativeMemories"), id))),
    ]);
    const observations = await Promise.all(experiment.observationIds.map(async (id) => {
      for (const session of sessions) {
        const observation = await kv.get<CompressedObservation>(KV.observations(session.id), id);
        if (observation) return observation;
      }
      return null;
    }));
    return {
      success: true,
      experiment,
      artifacts: artifacts.filter(Boolean),
      evidence: evidence.filter(Boolean),
      actions: actions.filter(Boolean),
      sessions: sessions.filter((session) => experiment.sessionIds?.includes(session.id)),
      observations: observations.filter(Boolean),
      graphNodes: graphNodes.filter(Boolean),
      negativeMemories: negativeMemories.filter(Boolean),
    };
  };

  sdk.registerFunction("mem::experiment-create", write);
  sdk.registerFunction("mem::experiment-write", write);
  sdk.registerFunction("mem::experiment-update", update);
  sdk.registerFunction("mem::experiment-get", get);
  sdk.registerFunction("mem::experiment-list", list);
  sdk.registerFunction("mem::experiment-query", query);
  sdk.registerFunction("mem::experiment-expand", expand);
}
