import type { StateKV } from "../state/kv.js";
import type { Artifact, Evidence, Experiment, NegativeMemory } from "../types.js";
import { structuredScope } from "./structured-records.js";

export type ExperimentLinkMode = "experiment" | "merge";

export interface ExperimentLinkReconciliation {
  experiments: Experiment[];
  updated: number;
}

function uniqueIds(ids: readonly string[] | undefined): string[] {
  return [...new Set((ids ?? []).filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()))];
}

function sameIds(left: readonly string[] | undefined, right: readonly string[]): boolean {
  const normalized = uniqueIds(left);
  return normalized.length === right.length && normalized.every((id, index) => id === right[index]);
}

function includeId(ids: readonly string[] | undefined, id: string): string[] {
  return uniqueIds([...(ids ?? []), id]);
}

function excludeId(ids: readonly string[] | undefined, id: string): string[] {
  return uniqueIds(ids).filter((value) => value !== id);
}

function isTracked(experiment: Experiment, trackedIds?: ReadonlySet<string>): boolean {
  return !trackedIds || trackedIds.has(experiment.id);
}

/**
 * Reconciles experiment forward links with the reverse fields already owned by
 * artifact, evidence, and negative-memory records. It deliberately leaves
 * timestamps, provenance, and authority intact: links are derived state, not
 * a new source assertion.
 */
export async function reconcileExperimentLinks(
  kv: StateKV,
  options: { experimentIds?: readonly string[]; mode?: ExperimentLinkMode } = {},
): Promise<ExperimentLinkReconciliation> {
  const mode = options.mode ?? "merge";
  const trackedIds = options.experimentIds ? new Set(uniqueIds(options.experimentIds)) : undefined;
  const [storedExperiments, artifacts, evidence, negativeMemories] = await Promise.all([
    kv.list<Experiment>(structuredScope("experiments")),
    kv.list<Artifact>(structuredScope("artifacts")),
    kv.list<Evidence>(structuredScope("evidence")),
    kv.list<NegativeMemory>(structuredScope("negativeMemories")),
  ]);
  const experiments = new Map<string, Experiment>(storedExperiments.map((experiment) => [experiment.id, {
    ...experiment,
    artifactIds: uniqueIds(experiment.artifactIds),
    evidenceIds: uniqueIds(experiment.evidenceIds),
    negativeMemoryIds: uniqueIds(experiment.negativeMemoryIds),
  }]));
  let updated = 0;

  const updateExperiment = (id: string, updater: (experiment: Experiment) => Experiment): void => {
    const current = experiments.get(id);
    if (!current) return;
    experiments.set(id, updater(current));
  };

  for (const artifact of artifacts) {
    const linkedIds = uniqueIds(artifact.experimentIds);
    for (const experiment of [...experiments.values()]) {
      if (!isTracked(experiment, trackedIds)) continue;
      const requested = experiment.artifactIds.includes(artifact.id);
      const reverse = linkedIds.includes(experiment.id);
      if (!requested && !reverse) continue;

      const linked = mode === "experiment" ? requested : requested || reverse;
      const nextArtifactIds = linked
        ? includeId(artifact.experimentIds, experiment.id)
        : excludeId(artifact.experimentIds, experiment.id);
      if (!sameIds(artifact.experimentIds, nextArtifactIds)) {
        await kv.set(structuredScope("artifacts"), artifact.id, {
          ...artifact,
          experimentIds: nextArtifactIds,
        });
        artifact.experimentIds = nextArtifactIds;
        updated++;
      }
      const nextExperimentArtifactIds = linked
        ? includeId(experiment.artifactIds, artifact.id)
        : excludeId(experiment.artifactIds, artifact.id);
      if (!sameIds(experiment.artifactIds, nextExperimentArtifactIds)) {
        updateExperiment(experiment.id, (current) => ({
          ...current,
          artifactIds: nextExperimentArtifactIds,
          artifacts: [...nextExperimentArtifactIds],
        }));
      }
    }
  }

  for (const negativeMemory of negativeMemories) {
    const linkedIds = uniqueIds(negativeMemory.experimentIds);
    for (const experiment of [...experiments.values()]) {
      if (!isTracked(experiment, trackedIds)) continue;
      const requested = experiment.negativeMemoryIds?.includes(negativeMemory.id) ?? false;
      const reverse = linkedIds.includes(experiment.id);
      if (!requested && !reverse) continue;

      const linked = mode === "experiment" ? requested : requested || reverse;
      const nextNegativeExperimentIds = linked
        ? includeId(negativeMemory.experimentIds, experiment.id)
        : excludeId(negativeMemory.experimentIds, experiment.id);
      if (!sameIds(negativeMemory.experimentIds, nextNegativeExperimentIds)) {
        await kv.set(structuredScope("negativeMemories"), negativeMemory.id, {
          ...negativeMemory,
          experimentIds: nextNegativeExperimentIds,
        });
        negativeMemory.experimentIds = nextNegativeExperimentIds;
        updated++;
      }
      const nextNegativeMemoryIds = linked
        ? includeId(experiment.negativeMemoryIds, negativeMemory.id)
        : excludeId(experiment.negativeMemoryIds, negativeMemory.id);
      if (!sameIds(experiment.negativeMemoryIds, nextNegativeMemoryIds)) {
        updateExperiment(experiment.id, (current) => ({
          ...current,
          negativeMemoryIds: nextNegativeMemoryIds,
        }));
      }
    }
  }

  for (const item of evidence) {
    const claimedBy = [...experiments.values()]
      .filter((experiment) => isTracked(experiment, trackedIds) && experiment.evidenceIds.includes(item.id))
      .sort((left, right) => left.id.localeCompare(right.id));
    const explicitRemoval = mode === "experiment" && item.experimentId &&
      !!trackedIds?.has(item.experimentId) && !claimedBy.some((experiment) => experiment.id === item.experimentId);
    if (explicitRemoval) {
      await kv.set(structuredScope("evidence"), item.id, {
        ...item,
        experimentId: undefined,
      });
      item.experimentId = undefined;
      updated++;
    }
    // Evidence has one canonical experiment owner. When several forward
    // records claim an unowned item, choose deterministically and remove the
    // competing forward claims rather than manufacturing a multi-owner state.
    const ownerId = item.experimentId ?? claimedBy[0]?.id;
    if (ownerId && !item.experimentId) {
      await kv.set(structuredScope("evidence"), item.id, {
        ...item,
        experimentId: ownerId,
      });
      item.experimentId = ownerId;
      updated++;
    }

    for (const experiment of claimedBy) {
      const linked = item.experimentId === experiment.id;
      const nextEvidenceIds = linked
        ? includeId(experiment.evidenceIds, item.id)
        : excludeId(experiment.evidenceIds, item.id);
      if (!sameIds(experiment.evidenceIds, nextEvidenceIds)) {
        updateExperiment(experiment.id, (current) => ({
          ...current,
          evidenceIds: nextEvidenceIds,
        }));
      }
    }

    if (ownerId && experiments.has(ownerId) && isTracked(experiments.get(ownerId)!, trackedIds)) {
      const owner = experiments.get(ownerId)!;
      const nextEvidenceIds = includeId(owner.evidenceIds, item.id);
      if (!sameIds(owner.evidenceIds, nextEvidenceIds)) {
        updateExperiment(ownerId, (current) => ({
          ...current,
          evidenceIds: nextEvidenceIds,
        }));
      }
    }
  }

  const reconciled = [...experiments.values()];
  for (const experiment of reconciled) {
    const stored = storedExperiments.find((candidate) => candidate.id === experiment.id)!;
    if (
      !sameIds(stored.artifactIds, experiment.artifactIds) ||
      !sameIds(stored.evidenceIds, experiment.evidenceIds) ||
      !sameIds(stored.negativeMemoryIds, experiment.negativeMemoryIds ?? [])
    ) {
      await kv.set(structuredScope("experiments"), experiment.id, experiment);
      updated++;
    }
  }

  return {
    experiments: reconciled.filter((experiment) => isTracked(experiment, trackedIds)),
    updated,
  };
}
