import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Memory } from "../src/types.js";
import { KV } from "../src/state/schema.js";
import { registerRememberFunction } from "../src/functions/remember.js";
import { registerRelationsFunction } from "../src/functions/relations.js";
import { getSearchIndex, setIndexPersistence } from "../src/functions/search.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

type RichTestMemory = Memory & {
  layer?: string;
  epistemicState?: string;
  temporal?: Record<string, unknown>;
  authority?: Record<string, unknown> | string;
  evidenceIds?: string[];
  artifactIds?: string[];
  experimentIds?: string[];
  conflictIds?: string[];
};

function makeMemory(
  id: string,
  overrides: Partial<RichTestMemory> = {},
): RichTestMemory {
  return {
    id,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    type: "fact",
    title: id,
    content: `content for ${id}`,
    concepts: ["test"],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: true,
    ...overrides,
  };
}

describe("memory temporal validity and epistemic metadata", () => {
  beforeEach(() => {
    getSearchIndex().clear();
    setIndexPersistence(null);
  });

  it("validates and persists explicit metadata with a durable writer provenance", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::remember", {
      content: "Camera HAL requires property X",
      state: "hypothesis",
      layer: "knowledge",
      temporal: {
        observedAt: "2026-07-14T00:00:00.000Z",
        validFrom: "2026-07-14T00:00:00.000Z",
      },
      authority: { kind: "agent", level: "low" },
      evidenceIds: ["evd_1"],
      artifactIds: ["art_1"],
      experimentIds: ["exp_1"],
      conflictIds: ["conf_1"],
    })) as { success: boolean; memory: RichTestMemory };

    expect(result.success).toBe(true);
    expect(result.memory.epistemicState).toBe("hypothesis");
    expect(result.memory.layer).toBe("knowledge");
    expect(result.memory.temporal?.validFrom).toBe("2026-07-14T00:00:00.000Z");
    expect(result.memory.authority).toEqual({ kind: "agent", level: "low" });
    expect(result.memory.evidenceIds).toEqual(["evd_1"]);
    expect(result.memory.origin).toEqual({ channel: "agent", capturedAt: expect.any(String) });

    const invalid = await sdk.trigger("mem::remember", {
      content: "bad state",
      state: "made-up-state",
    }) as { success: boolean; error: string };
    expect(invalid).toEqual({
      success: false,
      error: "epistemicState must be one of: hypothesis, observed, verified, disproven, superseded, uncertain",
    });
  });

  it("defaults only new memories and leaves legacy records without backfilling fields", async () => {
    const sdk = mockSdk({ looseTrigger: true });
    const kv = mockKV();
    registerRememberFunction(sdk as never, kv as never);
    const legacy = makeMemory("mem_legacy", {
      content: "legacy record with no epistemic metadata",
      epistemicState: undefined,
      layer: undefined,
    });
    delete legacy.epistemicState;
    delete legacy.layer;
    await kv.set(KV.memories, legacy.id, legacy);

    const result = (await sdk.trigger("mem::remember", {
      content: "legacy record with no epistemic metadata",
    })) as { memory: RichTestMemory };
    const storedLegacy = await kv.get<RichTestMemory>(KV.memories, legacy.id);

    expect(result.memory.epistemicState).toBe("observed");
    expect(result.memory.layer).toBe("knowledge");
    expect(result.memory.authority).toEqual({ source: "agent", score: 0.55 });
    expect(result.memory.origin).toEqual({ channel: "agent", capturedAt: expect.any(String) });
    expect(storedLegacy?.epistemicState).toBeUndefined();
    expect(storedLegacy?.layer).toBeUndefined();
    expect(storedLegacy?.isLatest).toBe(false);
  });
});

describe("authoritative contradiction lifecycle", () => {
  it("creates an open durable conflict and resolves states without deleting evidence", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRelationsFunction(sdk as never, kv as never);
    const first = makeMemory("mem_a", { epistemicState: "observed" });
    const second = makeMemory("mem_b", { epistemicState: "uncertain" });
    await kv.set(KV.memories, first.id, first);
    await kv.set(KV.memories, second.id, second);
    await kv.set(KV.evidence, "evd_1", { id: "evd_1", claim: "test evidence" });

    const related = (await sdk.trigger("mem::relate", {
      sourceId: first.id,
      targetId: second.id,
      type: "contradicts",
      evidenceIds: ["evd_1"],
    })) as { success: boolean; conflict: { id: string; status: string; evidenceIds?: string[] } };
    expect(related.success).toBe(true);
    expect(related.conflict.status).toBe("open");
    expect(related.conflict.evidenceIds).toEqual(["evd_1"]);

    const storedConflict = await kv.get<{ status: string }>(KV.conflicts, related.conflict.id);
    const linkedFirst = await kv.get<RichTestMemory>(KV.memories, first.id);
    const linkedSecond = await kv.get<RichTestMemory>(KV.memories, second.id);
    expect(storedConflict?.status).toBe("open");
    expect(linkedFirst?.conflictIds).toContain(related.conflict.id);
    expect(linkedSecond?.conflictIds).toContain(related.conflict.id);

    const resolved = (await sdk.trigger("mem::conflict-resolve", {
      conflictId: related.conflict.id,
      status: "resolved",
      memoryStates: {
        [first.id]: "verified",
        [second.id]: "disproven",
      },
      reason: "experiment confirmed the first claim",
    })) as { success: boolean; evidencePreserved: boolean };
    expect(resolved.success).toBe(true);
    expect(resolved.evidencePreserved).toBe(true);
    expect(await kv.get(KV.evidence, "evd_1")).not.toBeNull();
    expect((await kv.get<RichTestMemory>(KV.memories, first.id))?.epistemicState).toBe("verified");
    expect((await kv.get<RichTestMemory>(KV.memories, second.id))?.epistemicState).toBe("disproven");
    expect((await kv.get<RichTestMemory>(KV.memories, first.id))?.isLatest).toBe(true);
  });
});

describe("temporal memory query", () => {
  it("supports current, as-of, range, project, and agent filtering while retaining history", async () => {
    const sdk = mockSdk();
    const kv = mockKV();
    registerRelationsFunction(sdk as never, kv as never);
    const historical = makeMemory("mem_old", {
      project: "camera",
      agentId: "agent-a",
      isLatest: false,
      temporal: {
        validFrom: "2025-01-01T00:00:00.000Z",
        validUntil: "2025-12-31T23:59:59.999Z",
      },
    });
    const current = makeMemory("mem_current", {
      project: "camera",
      agentId: "agent-a",
      temporal: { validFrom: "2026-01-01T00:00:00.000Z" },
    });
    const otherAgent = makeMemory("mem_other", {
      project: "camera",
      agentId: "agent-b",
      temporal: { validFrom: "2026-01-01T00:00:00.000Z" },
    });
    await Promise.all([
      kv.set(KV.memories, historical.id, historical),
      kv.set(KV.memories, current.id, current),
      kv.set(KV.memories, otherAgent.id, otherAgent),
    ]);

    const currentResult = (await sdk.trigger("mem::temporal-memory-query", {
      project: "camera",
      agentId: "agent-a",
      mode: "current",
    })) as { memories: RichTestMemory[] };
    expect(currentResult.memories.map((memory) => memory.id)).toEqual(["mem_current"]);

    const wildcardResult = (await sdk.trigger("mem::temporal-memory-query", {
      project: "camera",
      agentId: "*",
      mode: "current",
    })) as { memories: RichTestMemory[] };
    expect(wildcardResult.memories.map((memory) => memory.id).sort()).toEqual([
      "mem_current",
      "mem_other",
    ]);

    const asOfResult = (await sdk.trigger("mem::temporal-memory-query", {
      project: "camera",
      agentId: "agent-a",
      asOf: "2025-06-01T00:00:00.000Z",
    })) as { memories: RichTestMemory[] };
    expect(asOfResult.memories.map((memory) => memory.id)).toEqual(["mem_old"]);

    const rangeResult = (await sdk.trigger("mem::temporal-memory-query", {
      project: "camera",
      from: "2025-06-01T00:00:00.000Z",
      to: "2025-06-02T00:00:00.000Z",
    })) as { memories: RichTestMemory[] };
    expect(rangeResult.memories.map((memory) => memory.id)).toContain("mem_old");
    expect(await kv.get(KV.memories, historical.id)).not.toBeNull();
  });
});
