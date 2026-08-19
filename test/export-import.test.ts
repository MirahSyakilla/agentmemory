import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { registerExportImportFunction } from "../src/functions/export-import.js";
import { VERSION } from "../src/version.js";
import {
  getSearchIndex,
  setEmbeddingProvider,
  setVectorIndex,
} from "../src/functions/search.js";
import type {
  Session,
  CompressedObservation,
  Memory,
  SessionSummary,
  ExportData,
  Evidence,
  Artifact,
  Experiment,
  NegativeMemory,
  MemoryConflict,
} from "../src/types.js";
import { memoryToObservation } from "../src/state/memory-utils.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list: async <T>(scope: string): Promise<T[]> => {
      const entries = store.get(scope);
      return entries ? (Array.from(entries.values()) as T[]) : [];
    },
  };
}

function mockSdk() {
  const functions = new Map<string, Function>();
  return {
    registerFunction: (idOrOpts: string | { id: string }, handler: Function) => {
      const id = typeof idOrOpts === "string" ? idOrOpts : idOrOpts.id;
      functions.set(id, handler);
    },
    registerTrigger: () => {},
    trigger: async (idOrInput: string | { function_id: string; payload: unknown }, data?: unknown) => {
      const id = typeof idOrInput === "string" ? idOrInput : idOrInput.function_id;
      const payload = typeof idOrInput === "string" ? data : idOrInput.payload;
      const fn = functions.get(id);
      if (!fn) throw new Error(`No function: ${id}`);
      return fn(payload);
    },
  };
}

const testSession: Session = {
  id: "ses_1",
  project: "my-project",
  cwd: "/tmp",
  startedAt: "2026-02-01T00:00:00Z",
  status: "completed",
  observationCount: 1,
};

const testObs: CompressedObservation = {
  id: "obs_1",
  sessionId: "ses_1",
  timestamp: "2026-02-01T10:00:00Z",
  type: "file_edit",
  title: "Edit auth",
  facts: ["Added check"],
  narrative: "Auth changes",
  concepts: ["auth"],
  files: ["src/auth.ts"],
  importance: 7,
};

const testMemory: Memory = {
  id: "mem_1",
  createdAt: "2026-02-01T00:00:00Z",
  updatedAt: "2026-02-01T00:00:00Z",
  type: "pattern",
  title: "Auth pattern",
  content: "Always validate tokens",
  concepts: ["auth"],
  files: [],
  sessionIds: ["ses_1"],
  strength: 5,
  version: 1,
  isLatest: true,
};

const testSummary: SessionSummary = {
  sessionId: "ses_1",
  project: "my-project",
  createdAt: "2026-02-01T00:00:00Z",
  title: "Auth work",
  narrative: "Worked on auth",
  keyDecisions: ["Use JWT"],
  filesModified: ["src/auth.ts"],
  concepts: ["auth"],
  observationCount: 1,
};

describe("Export/Import Functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(async () => {
    sdk = mockSdk();
    kv = mockKV();
    // getSearchIndex() returns a module-level singleton shared across
    // tests. Clear it so index assertions here don't see rows added by
    // a prior test's import.
    getSearchIndex().clear();
    registerExportImportFunction(sdk as never, kv as never);
    setVectorIndex(null);
    setEmbeddingProvider(null);

    await kv.set("mem:sessions", "ses_1", testSession);
    await kv.set("mem:obs:ses_1", "obs_1", testObs);
    await kv.set("mem:memories", "mem_1", testMemory);
    await kv.set("mem:summaries", "ses_1", testSummary);
  });

  it("export produces valid ExportData structure", async () => {
    const result = (await sdk.trigger("mem::export", {})) as ExportData;

    expect(result.version).toBe(VERSION);
    expect(result.exportedAt).toBeDefined();
    expect(result.sessions.length).toBe(1);
    expect(result.sessions[0].id).toBe("ses_1");
    expect(result.observations["ses_1"].length).toBe(1);
    expect(result.memories.length).toBe(1);
    expect(result.summaries.length).toBe(1);
  });

  it("import with merge strategy adds data", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [{ ...testSession, id: "ses_2", observationCount: 0 }],
      observations: {},
      memories: [{ ...testMemory, id: "mem_2", title: "New pattern" }],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; sessions: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);
    expect(result.memories).toBe(1);

    const allSessions = await kv.list("mem:sessions");
    expect(allSessions.length).toBe(2);
  });

  it("import adds imported records to the search index", async () => {
    // Regression: mem::import wrote rows to KV but never indexed them.
    // On an existing install the boot rebuild gate (bm25.size === 0) is
    // false, so imported data stayed invisible to mem::search forever.
    const importedObs: CompressedObservation = {
      id: "obs_imported",
      sessionId: "ses_imported",
      timestamp: "2026-03-01T10:00:00Z",
      type: "file_edit",
      title: "Kubernetes deployment rollout",
      facts: ["Scaled replicas"],
      narrative: "Adjusted the kubernetes deployment rollout strategy",
      concepts: ["k8s"],
      files: ["deploy.yaml"],
      importance: 6,
    };
    const importedMem: Memory = {
      ...testMemory,
      id: "mem_imported",
      title: "Postgres connection pooling",
      content: "Use pgbouncer for postgres connection pooling",
    };
    const exportData: ExportData = {
      version: "0.9.28",
      exportedAt: new Date().toISOString(),
      sessions: [
        { ...testSession, id: "ses_imported", observationCount: 1 },
      ],
      observations: { ses_imported: [importedObs] },
      memories: [importedMem],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; observations: number; memories: number };

    expect(result.success).toBe(true);
    expect(result.observations).toBe(1);
    expect(result.memories).toBe(1);

    const idx = getSearchIndex();
    expect(idx.has("obs_imported")).toBe(true);
    expect(idx.has("mem_imported")).toBe(true);

    const obsHit = idx.search("kubernetes rollout");
    expect(obsHit.some((r) => r.obsId === "obs_imported")).toBe(true);

    const memHit = idx.search("postgres pooling");
    expect(memHit.some((r) => r.obsId === "mem_imported")).toBe(true);
  });

  it("import with skip strategy does not overwrite existing", async () => {
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [testSession],
      observations: { ses_1: [testObs] },
      memories: [testMemory],
      summaries: [testSummary],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "skip",
    })) as { success: boolean; skipped: number; sessions: number };

    expect(result.success).toBe(true);
    expect(result.skipped).toBeGreaterThan(0);
    expect(result.sessions).toBe(0);
  });

  it("import with replace strategy clears existing data first", async () => {
    const newSession: Session = {
      id: "ses_new",
      project: "new-project",
      cwd: "/tmp/new",
      startedAt: "2026-03-01T00:00:00Z",
      status: "active",
      observationCount: 0,
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [newSession],
      observations: {},
      memories: [],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; sessions: number };

    expect(result.success).toBe(true);
    expect(result.sessions).toBe(1);

    const oldSession = await kv.get("mem:sessions", "ses_1");
    expect(oldSession).toBeNull();
  });

  it("import with replace strategy rebuilds the search index from imported memories", async () => {
    const staleMemory: Memory = {
      ...testMemory,
      id: "mem_stale",
      title: "Stale auth pattern",
      content: "Legacy memory that should be dropped from the index",
    };
    getSearchIndex().add(memoryToObservation(staleMemory));
    expect(getSearchIndex().has("mem_stale")).toBe(true);

    const freshMemory: Memory = {
      ...testMemory,
      id: "mem_fresh",
      title: "Fresh auth pattern",
      content: "Imported memory that should exist in the rebuilt index",
    };
    const exportData: ExportData = {
      version: "0.3.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [freshMemory],
      summaries: [],
    };

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "replace",
    })) as { success: boolean; memories: number };

    expect(result.success).toBe(true);
    expect(result.memories).toBe(1);
    expect(getSearchIndex().has("mem_stale")).toBe(false);
    expect(getSearchIndex().has("mem_fresh")).toBe(true);
  });

  it("export then import round-trip preserves data", async () => {
    const exported = (await sdk.trigger("mem::export", {})) as ExportData;

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const importResult = (await freshSdk.trigger("mem::import", {
      exportData: exported,
      strategy: "merge",
    })) as {
      success: boolean;
      sessions: number;
      observations: number;
      memories: number;
    };

    expect(importResult.success).toBe(true);
    expect(importResult.sessions).toBe(1);
    expect(importResult.observations).toBe(1);
    expect(importResult.memories).toBe(1);

    const reExported = (await freshSdk.trigger(
      "mem::export",
      {},
    )) as ExportData;
    expect(reExported.sessions.length).toBe(exported.sessions.length);
    expect(reExported.memories.length).toBe(exported.memories.length);
  });

  it("exports and imports structured evidence, artifacts, experiments, negative memory, and conflicts", async () => {
    const evidence: Evidence = {
      id: "evd_1",
      kind: "log",
      type: "log",
      sourceIds: [],
      provenance: { channel: "tool", capturedAt: "2026-08-19T00:00:00.000Z" },
      capturedAt: "2026-08-19T00:00:00.000Z",
      createdAt: "2026-08-19T00:00:00.000Z",
    };
    const artifact: Artifact = {
      id: "art_1",
      name: "report.json",
      kind: "report",
      type: "report",
      experimentIds: ["exp_1"],
      evidenceIds: [evidence.id],
      provenance: evidence.provenance,
      createdAt: evidence.createdAt,
      updatedAt: evidence.createdAt,
    };
    const experiment: Experiment = {
      id: "exp_1",
      objective: "Verify export",
      commands: [],
      inputs: [],
      artifactIds: [artifact.id],
      observationIds: [],
      evidenceIds: [evidence.id],
      followUp: [],
      status: "completed",
      provenance: evidence.provenance,
      createdAt: evidence.createdAt,
      updatedAt: evidence.createdAt,
    };
    const negative: NegativeMemory = {
      id: "neg_1",
      approach: "skip export",
      statement: "skip export is invalid",
      reason: "verified persistence requirement",
      status: "invalid",
      experimentIds: [experiment.id],
      evidenceIds: [evidence.id],
      confidence: 1,
      provenance: evidence.provenance,
      createdAt: evidence.createdAt,
      updatedAt: evidence.createdAt,
    };
    const conflict: MemoryConflict = {
      id: "conf_1",
      memoryIds: ["mem_1", "mem_2"],
      status: "open",
      detectedBy: "manual",
      createdAt: evidence.createdAt,
      updatedAt: evidence.createdAt,
    };
    await Promise.all([
      kv.set("mem:evidence", evidence.id, evidence),
      kv.set("mem:artifacts", artifact.id, artifact),
      kv.set("mem:experiments", experiment.id, experiment),
      kv.set("mem:negative-memories", negative.id, negative),
      kv.set("mem:conflicts", conflict.id, conflict),
    ]);

    const exported = (await sdk.trigger("mem::export", {})) as ExportData;
    expect(exported.evidence?.[0].id).toBe(evidence.id);
    expect(exported.artifacts?.[0].id).toBe(artifact.id);
    expect(exported.experiments?.[0].id).toBe(experiment.id);
    expect(exported.negativeMemories?.[0].id).toBe(negative.id);
    expect(exported.conflicts?.[0].id).toBe(conflict.id);

    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);
    await freshSdk.trigger("mem::import", { exportData: exported, strategy: "merge" });
    expect(await freshKv.get("mem:evidence", evidence.id)).not.toBeNull();
    expect(await freshKv.get("mem:artifacts", artifact.id)).not.toBeNull();
    expect(await freshKv.get("mem:experiments", experiment.id)).not.toBeNull();
    expect(await freshKv.get("mem:negative-memories", negative.id)).not.toBeNull();
    expect(await freshKv.get("mem:conflicts", conflict.id)).not.toBeNull();
  });

  it("reconciles imported structured experiment links without changing authority", async () => {
    const timestamp = "2026-08-19T00:00:00.000Z";
    const provenance = { channel: "user" as const, capturedAt: timestamp };
    const evidence: Evidence = {
      id: "evd_linked",
      kind: "log",
      type: "log",
      sourceIds: [],
      provenance,
      capturedAt: timestamp,
      createdAt: timestamp,
    };
    const artifact: Artifact = {
      id: "art_linked",
      name: "report.txt",
      kind: "report",
      type: "report",
      experimentIds: [],
      evidenceIds: [],
      provenance,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const experiment: Experiment = {
      id: "exp_linked",
      objective: "Preserve imported links",
      commands: [],
      inputs: [],
      artifactIds: [artifact.id],
      observationIds: ["obs_1"],
      evidenceIds: [evidence.id],
      actionIds: ["act_1"],
      sessionIds: ["ses_1"],
      graphNodeIds: ["gn_1"],
      negativeMemoryIds: ["neg_linked"],
      followUp: [],
      status: "completed",
      provenance,
      authority: { source: "user", confidence: 1 },
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const negativeMemory: NegativeMemory = {
      id: "neg_linked",
      approach: "skip the import",
      statement: "Skipping is invalid",
      reason: "the experiment requires it",
      status: "invalid",
      experimentIds: [],
      evidenceIds: [],
      confidence: 1,
      provenance,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    const exportData: ExportData = {
      version: "0.9.29",
      exportedAt: timestamp,
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
      evidence: [evidence],
      artifacts: [artifact],
      experiments: [experiment],
      negativeMemories: [negativeMemory],
    };
    const freshKv = mockKV();
    const freshSdk = mockSdk();
    registerExportImportFunction(freshSdk as never, freshKv as never);

    const result = (await freshSdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean };
    expect(result.success).toBe(true);
    expect((await freshKv.get<Artifact>("mem:artifacts", artifact.id))?.experimentIds).toEqual([experiment.id]);
    expect((await freshKv.get<Evidence>("mem:evidence", evidence.id))?.experimentId).toBe(experiment.id);
    expect((await freshKv.get<NegativeMemory>("mem:negative-memories", negativeMemory.id))?.experimentIds).toEqual([experiment.id]);
    expect((await freshKv.get<Experiment>("mem:experiments", experiment.id))?.authority).toEqual({ source: "user", confidence: 1 });
  });

  it("import rejects unsupported version", async () => {
    const exportData = {
      version: "1.0.0",
      exportedAt: new Date().toISOString(),
      sessions: [],
      observations: {},
      memories: [],
      summaries: [],
    } as unknown as ExportData;

    const result = (await sdk.trigger("mem::import", {
      exportData,
      strategy: "merge",
    })) as { success: boolean; error: string };

    expect(result.success).toBe(false);
    expect(result.error).toContain("Unsupported export version");
  });
});
