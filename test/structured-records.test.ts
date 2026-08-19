import { beforeEach, describe, expect, it } from "vitest";

import { registerArtifactFunctions } from "../src/functions/artifacts.js";
import { registerEvidenceFunctions } from "../src/functions/evidence.js";
import { registerExperimentFunctions } from "../src/functions/experiments.js";
import { registerNegativeMemoryFunctions } from "../src/functions/negative-memories.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      [...(store.get(scope)?.values() ?? [])] as T[],
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
  };
}

function mockSdk() {
  const handlers = new Map<string, (input: unknown) => Promise<unknown>>();
  return {
    registerFunction: (id: string, handler: (input: unknown) => Promise<unknown>) => {
      handlers.set(id, handler);
    },
    trigger: async (id: string, input: unknown) => {
      const handler = handlers.get(id);
      if (!handler) throw new Error(`No function: ${id}`);
      return handler(input);
    },
  };
}

const provenance = {
  channel: "tool" as const,
  capturedAt: "2026-08-19T00:00:00.000Z",
  source: "focused-test",
};

describe("structured evidence records", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
    registerEvidenceFunctions(sdk as never, kv as never);
    registerArtifactFunctions(sdk as never, kv as never);
    registerExperimentFunctions(sdk as never, kv as never);
    registerNegativeMemoryFunctions(sdk as never, kv as never);
  });

  it("validates provenance and filters evidence by project and agent", async () => {
    const rejected = (await sdk.trigger("mem::evidence-write", {
      kind: "log",
      content: "boot failed",
    })) as { success: boolean; error: string };
    expect(rejected.success).toBe(false);
    expect(rejected.error).toContain("provenance");

    await sdk.trigger("mem::evidence-write", {
      kind: "log",
      content: "camera HAL failed to load",
      project: "camera",
      agentId: "agent-a",
      provenance,
    });
    await sdk.trigger("mem::evidence-write", {
      kind: "log",
      content: "camera HAL passed",
      project: "camera",
      agentId: "agent-b",
      provenance,
    });

    const result = (await sdk.trigger("mem::evidence-query", {
      query: "camera HAL failed",
      project: "camera",
      agentId: "agent-a",
    })) as { success: boolean; evidence: Array<{ content: string }> };
    expect(result.success).toBe(true);
    expect(result.evidence).toHaveLength(1);
    expect(result.evidence[0].content).toContain("failed");

    const wildcard = (await sdk.trigger("mem::evidence-query", {
      query: "camera HAL",
      project: "camera",
      agentId: "*",
    })) as { success: boolean; evidence: Array<{ content: string }> };
    expect(wildcard.evidence).toHaveLength(2);
  });

  it("stores artifact and expands linked experiment records", async () => {
    const artifactResult = (await sdk.trigger("mem::artifact-write", {
      name: "boot.img",
      kind: "build",
      project: "kernel",
      provenance,
    })) as { artifact: { id: string } };
    const artifactQuery = (await sdk.trigger("mem::artifact-query", {
      query: "boot.img",
      project: "kernel",
    })) as { artifacts: Array<{ id: string }> };
    expect(artifactQuery.artifacts.map((artifact) => artifact.id)).toContain(artifactResult.artifact.id);
    const evidenceResult = (await sdk.trigger("mem::evidence-write", {
      kind: "log",
      content: "boot successful",
      project: "kernel",
      provenance,
    })) as { evidence: { id: string } };

    const experimentResult = (await sdk.trigger("mem::experiment-create", {
      objective: "Check whether the kernel boots",
      hypothesis: "The new config boots the device",
      project: "kernel",
      artifactIds: [artifactResult.artifact.id],
      evidenceIds: [evidenceResult.evidence.id],
      commands: ["fastboot boot boot.img"],
      provenance,
    })) as { success: boolean; experiment: { id: string; status: string } };
    expect(experimentResult.success).toBe(true);
    expect(experimentResult.experiment.status).toBe("planned");

    const expanded = (await sdk.trigger("mem::experiment-expand", {
      id: experimentResult.experiment.id,
    })) as { artifacts: unknown[]; evidence: unknown[] };
    expect(expanded.artifacts).toHaveLength(1);
    expect(expanded.evidence).toHaveLength(1);
  });

  it("reconciles experiment links without multiplying evidence ownership", async () => {
    const artifactResult = (await sdk.trigger("mem::artifact-write", {
      name: "boot.img",
      kind: "build",
      provenance,
    })) as { artifact: { id: string } };
    const evidenceResult = (await sdk.trigger("mem::evidence-write", {
      kind: "log",
      content: "boot passed",
      provenance,
    })) as { evidence: { id: string } };
    const negativeResult = (await sdk.trigger("mem::negative-memory-write", {
      approach: "disable CONFIG_BOOT",
      reason: "did not fix the boot failure",
      provenance,
    })) as { negativeMemory: { id: string } };
    await Promise.all([
      kv.set("mem:actions", "act_1", {
        id: "act_1",
        title: "Boot test",
        description: "Run the image",
        status: "done",
        priority: 1,
        createdAt: "2026-08-19T00:00:00.000Z",
        updatedAt: "2026-08-19T00:00:00.000Z",
        createdBy: "agent",
        tags: [],
        sourceObservationIds: [],
        sourceMemoryIds: [],
      }),
      kv.set("mem:sessions", "ses_1", {
        id: "ses_1",
        project: "kernel",
        cwd: "/tmp/kernel",
        startedAt: "2026-08-19T00:00:00.000Z",
        status: "completed",
        observationCount: 1,
      }),
      kv.set("mem:obs:ses_1", "obs_1", {
        id: "obs_1",
        sessionId: "ses_1",
        timestamp: "2026-08-19T00:00:00.000Z",
        type: "command_run",
        title: "Boot passed",
        facts: [],
        narrative: "The image booted",
        concepts: [],
        files: [],
        importance: 5,
      }),
      kv.set("mem:graph:nodes", "gn_1", {
        id: "gn_1",
        type: "project",
        name: "kernel",
        properties: {},
        sourceObservationIds: [],
        createdAt: "2026-08-19T00:00:00.000Z",
      }),
    ]);

    const created = (await sdk.trigger("mem::experiment-create", {
      objective: "Boot the test image",
      artifactIds: [artifactResult.artifact.id],
      evidenceIds: [evidenceResult.evidence.id],
      actionIds: ["act_1"],
      sessionIds: ["ses_1"],
      observationIds: ["obs_1"],
      graphNodeIds: ["gn_1"],
      negativeMemoryIds: [negativeResult.negativeMemory.id],
      provenance,
    })) as { experiment: { id: string; negativeMemoryIds?: string[] } };

    const [artifact, evidence, negativeMemory] = await Promise.all([
      kv.get<{ experimentIds: string[] }>("mem:artifacts", artifactResult.artifact.id),
      kv.get<{ experimentId?: string }>("mem:evidence", evidenceResult.evidence.id),
      kv.get<{ experimentIds: string[] }>("mem:negative-memories", negativeResult.negativeMemory.id),
    ]);
    expect(artifact?.experimentIds).toEqual([created.experiment.id]);
    expect(evidence?.experimentId).toBe(created.experiment.id);
    expect(negativeMemory?.experimentIds).toEqual([created.experiment.id]);

    const expanded = (await sdk.trigger("mem::experiment-expand", {
      id: created.experiment.id,
    })) as {
      actions: unknown[];
      sessions: unknown[];
      observations: unknown[];
      graphNodes: unknown[];
      negativeMemories: unknown[];
    };
    expect(expanded.actions).toHaveLength(1);
    expect(expanded.sessions).toHaveLength(1);
    expect(expanded.observations).toHaveLength(1);
    expect(expanded.graphNodes).toHaveLength(1);
    expect(expanded.negativeMemories).toHaveLength(1);

    await sdk.trigger("mem::experiment-update", {
      id: created.experiment.id,
      artifactIds: [],
      evidenceIds: [],
      negativeMemoryIds: [],
    });
    expect((await kv.get<{ experimentIds: string[] }>("mem:artifacts", artifactResult.artifact.id))?.experimentIds).toEqual([]);
    expect((await kv.get<{ experimentId?: string }>("mem:evidence", evidenceResult.evidence.id))?.experimentId).toBeUndefined();
    expect((await kv.get<{ experimentIds: string[] }>("mem:negative-memories", negativeResult.negativeMemory.id))?.experimentIds).toEqual([]);

    await kv.set("mem:evidence", "evd_foreign", {
      id: "evd_foreign",
      kind: "log",
      type: "log",
      sourceIds: [],
      experimentId: "exp_existing",
      provenance,
      capturedAt: provenance.capturedAt,
      createdAt: provenance.capturedAt,
    });
    const competing = (await sdk.trigger("mem::experiment-create", {
      objective: "Do not steal evidence",
      evidenceIds: ["evd_foreign"],
      provenance,
    })) as { experiment: { evidenceIds: string[] } };
    expect(competing.experiment.evidenceIds).toEqual([]);
    expect((await kv.get<{ experimentId?: string }>("mem:evidence", "evd_foreign"))?.experimentId).toBe("exp_existing");
  });

  it("updates and queries experiments within a project scope", async () => {
    const created = (await sdk.trigger("mem::experiment-write", {
      objective: "Try config A",
      project: "device-a",
      provenance,
    })) as { experiment: { id: string } };
    await sdk.trigger("mem::experiment-update", {
      experimentId: created.experiment.id,
      status: "failed",
      conclusion: "Config A had no effect",
    });
    await sdk.trigger("mem::experiment-write", {
      objective: "Try config A",
      project: "device-b",
      provenance,
    });

    const result = (await sdk.trigger("mem::experiment-query", {
      query: "config A no effect",
      project: "device-a",
    })) as { experiments: Array<{ status: string; conclusion?: string }> };
    expect(result.experiments).toHaveLength(1);
    expect(result.experiments[0].status).toBe("failed");
    expect(result.experiments[0].conclusion).toBe("Config A had no effect");
  });

  it("returns reusable negative knowledge with exact-match and scope preference", async () => {
    await sdk.trigger("mem::negative-memory-write", {
      approach: "disable CONFIG_FOO",
      reason: "tested build 183 and observed no change",
      project: "kernel",
      environment: "pixel-x",
      provenance,
    });
    await sdk.trigger("mem::negative-memory-write", {
      approach: "disable CONFIG_FOO",
      reason: "unrelated project result",
      project: "other",
      provenance,
    });

    const result = (await sdk.trigger("mem::negative-memory-lookup", {
      query: "disable CONFIG_FOO",
      project: "kernel",
      environment: "pixel-x",
    })) as { shouldNotRetry: boolean; negativeMemories: Array<{ project?: string; score: number }> };
    expect(result.shouldNotRetry).toBe(true);
    expect(result.negativeMemories).toHaveLength(1);
    expect(result.negativeMemories[0].project).toBe("kernel");
    expect(result.negativeMemories[0].score).toBe(1);
  });

  it("persists evidence verification state and can retrieve it by ID", async () => {
    const created = (await sdk.trigger("mem::evidence-write", {
      kind: "command_output",
      content: "focused test suite passed",
      project: "agentmemory",
      provenance,
    })) as { evidence: { id: string } };
    const verified = (await sdk.trigger("mem::evidence-verify", {
      id: created.evidence.id,
      verifier: "vitest",
      verificationMethod: "focused suite",
      result: { passed: true },
      project: "agentmemory",
    })) as {
      success: boolean;
      evidence: { verifier: string; verificationMethod: string; verifiedAt?: string; metadata?: Record<string, unknown> };
    };

    expect(verified.success).toBe(true);
    expect(verified.evidence.verifier).toBe("vitest");
    expect(verified.evidence.verificationMethod).toBe("focused suite");
    expect(verified.evidence.verifiedAt).toBeTruthy();
    expect(verified.evidence.metadata?.verificationResult).toEqual({ passed: true });
  });
});
