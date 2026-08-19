import { beforeEach, describe, expect, it } from "vitest";
import { KV } from "../src/state/schema.js";
import {
  registerPlannedRetrievalFunctions,
  type PlannedRetrievalResponse,
} from "../src/functions/planned-retrieval.js";
import { mockKV, mockSdk } from "./helpers/mocks.js";

const PROJECT = "camera";
const AGENT = "planner-agent";
const QUERY = "AuthService as of 2025-06-01 with evidence";

function makeMemory(id: string, state: string) {
  return {
    id,
    createdAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-05-01T00:00:00.000Z",
    type: "fact" as const,
    title: `${id} AuthService state`,
    content: `AuthService was ${state}.`,
    concepts: ["AuthService"],
    files: [],
    sessionIds: [],
    strength: 5,
    version: 1,
    isLatest: false,
    project: PROJECT,
    agentId: AGENT,
    temporal: {
      validFrom: "2025-01-01T00:00:00.000Z",
      validUntil: "2025-12-31T23:59:59.999Z",
    },
    claims: { state },
  };
}

describe("planned retrieval functions", () => {
  let sdk: ReturnType<typeof mockSdk>;
  let kv: ReturnType<typeof mockKV>;

  beforeEach(() => {
    sdk = mockSdk();
    kv = mockKV();
  });

  it("merges temporal memory and structured queries under a strict public budget", async () => {
    const calls: Array<{ functionId: string; payload: Record<string, unknown> }> = [];
    sdk.fns.set("mem::search", async (payload) => {
      calls.push({ functionId: "mem::search", payload: payload as Record<string, unknown> });
      return { results: [] };
    });
    const registerStructured = (
      functionId: string,
      field: string,
      records: Record<string, unknown>[],
    ) => {
      sdk.fns.set(functionId, async (payload) => {
        calls.push({ functionId, payload: payload as Record<string, unknown> });
        return { success: true, [field]: records, ...(field === "negativeMemories" ? { shouldNotRetry: true } : {}) };
      });
    };
    registerStructured("mem::experiment-query", "experiments", [
      {
        id: "exp_auth",
        objective: "Verify AuthService rollout",
        result: "The experiment produced the expected auth result.",
        project: PROJECT,
        agentId: AGENT,
        score: 0.98,
        createdAt: "2025-05-02T00:00:00.000Z",
      },
    ]);
    registerStructured("mem::artifact-query", "artifacts", [
      {
        id: "art_auth",
        name: "auth-report.txt",
        description: "ARTIFACT SECRET: complete AuthService diagnostic output.",
        project: PROJECT,
        agentId: AGENT,
        score: 0.97,
        createdAt: "2025-05-02T00:00:00.000Z",
      },
    ]);
    registerStructured("mem::evidence-query", "evidence", [
      {
        id: "evd_auth",
        kind: "test-log",
        content: "EVIDENCE SECRET: AuthService integration test passed.",
        project: PROJECT,
        agentId: AGENT,
        score: 0.96,
        createdAt: "2025-05-02T00:00:00.000Z",
      },
    ]);
    registerStructured("mem::negative-memory-lookup", "negativeMemories", [
      {
        id: "neg_auth",
        approach: "Disable AuthService",
        reason: "NEGATIVE SECRET: this breaks device enrollment.",
        status: "failed",
        project: PROJECT,
        agentId: AGENT,
        score: 0.95,
        createdAt: "2025-05-02T00:00:00.000Z",
      },
    ]);
    await Promise.all([
      kv.set(KV.memories, "mem_enabled", makeMemory("mem_enabled", "enabled")),
      kv.set(KV.memories, "mem_disabled", makeMemory("mem_disabled", "disabled")),
    ]);
    registerPlannedRetrievalFunctions(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-plan", {
      query: QUERY,
      project: PROJECT,
      agentId: AGENT,
      limit: 20,
      tokenBudget: 0,
      budgets: { direct: 999, supporting: 999, historical: 999, provenance: 999 },
    })) as PlannedRetrievalResponse;

    expect(sdk.fns.has("mem::retrieval-plan")).toBe(true);
    expect(sdk.fns.has("mem::retrieval-expand")).toBe(true);
    expect(result.success).toBe(true);
    expect(result.context.budgets).toEqual({
      total: 0,
      direct: 0,
      supporting: 0,
      historical: 0,
      provenance: 0,
    });
    expect(result.context.tokensUsed).toBe(0);
    expect(Object.values(result.context.tiers).flat()).toEqual([]);
    expect(result.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "exp_auth", contextId: "experiment:exp_auth", kind: "experiment" }),
        expect.objectContaining({ id: "art_auth", contextId: "artifact:art_auth", kind: "artifact" }),
        expect.objectContaining({ id: "evd_auth", contextId: "evidence:evd_auth", kind: "evidence" }),
        expect.objectContaining({ id: "neg_auth", contextId: "negative_memory:neg_auth", kind: "negative_memory" }),
        expect.objectContaining({ id: "mem_enabled", historical: true }),
      ]),
    );
    expect(result.negativeMemories).toEqual([
      { id: "neg_auth", score: 0.95, status: "failed", shouldNotRetry: true },
    ]);
    expect(result.diagnostics.conflicts).toContainEqual({
      candidateIds: ["mem_disabled", "mem_enabled"],
      reason: "claim_value",
      claim: "state",
    });
    expect(result.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ source: "hybrid", requested: true, available: true }),
        expect.objectContaining({ source: "graph", requested: true }),
        expect.objectContaining({ source: "temporal_memory", requested: true, received: 2 }),
        expect.objectContaining({ source: "experiments", available: true, received: 1 }),
        expect.objectContaining({ source: "artifacts", available: true, received: 1 }),
        expect.objectContaining({ source: "evidence", available: true, received: 1 }),
        expect.objectContaining({ source: "negative_memories", available: true, received: 1 }),
      ]),
    );
    for (const call of calls) {
      expect(call.payload.project).toBe(PROJECT);
      expect(call.payload.agentId).toBe(AGENT);
    }
    const negativeCall = calls.find((call) => call.functionId === "mem::negative-memory-lookup")!;
    expect(negativeCall.payload.asOf).toBe("2025-06-01");

    const { context: _context, ...outsideContext } = result;
    expect(JSON.stringify(outsideContext)).not.toContain("SECRET");
    expect(result.handles.every((handle) => !Object.hasOwn(handle, "preview"))).toBe(true);
    expect(result.handles.every((handle) => !handle.handle.includes("ctx:"))).toBe(true);
  });

  it("allows expansion only through an opaque handle bound to the original scope", async () => {
    sdk.fns.set("mem::search", async () => ({ results: [] }));
    sdk.fns.set("mem::experiment-query", async () => ({ success: true, experiments: [] }));
    sdk.fns.set("mem::artifact-query", async () => ({
      success: true,
      artifacts: [
        {
          id: "art_secret",
          name: "secret.txt",
          description: "ARTIFACT SECRET: expansion-only content.",
          project: PROJECT,
          agentId: AGENT,
          score: 1,
        },
      ],
    }));
    sdk.fns.set("mem::evidence-query", async () => ({ success: true, evidence: [] }));
    sdk.fns.set("mem::negative-memory-lookup", async () => ({
      success: true,
      negativeMemories: [],
      shouldNotRetry: false,
    }));
    registerPlannedRetrievalFunctions(sdk as never, kv as never);

    const plan = (await sdk.trigger("mem::retrieval-plan", {
      query: "artifact secret",
      project: PROJECT,
      agentId: AGENT,
      tokenBudget: 0,
    })) as PlannedRetrievalResponse;
    const handle = plan.handles.find((entry) => entry.itemId === "artifact:art_secret")!;

    const wrongScope = await sdk.trigger("mem::retrieval-expand", {
      handle: handle.handle,
      project: "other-project",
      agentId: AGENT,
    }) as { success: boolean; error?: string };
    expect(wrongScope).toEqual({
      success: false,
      error: "retrieval expansion scope does not match plan",
    });

    const expanded = await sdk.trigger("mem::retrieval-expand", {
      handle: handle.handle,
      project: PROJECT,
      agentId: AGENT,
      tokenBudget: 1_000,
    }) as { success: boolean; expansion?: { content: string } };
    expect(expanded.success).toBe(true);
    expect(expanded.expansion?.content).toContain("ARTIFACT SECRET: expansion-only content.");
  });

  it("returns bounded evidence metadata and keeps evidence bodies out of public context", async () => {
    sdk.fns.set("mem::search", async () => ({ results: [] }));
    sdk.fns.set("mem::experiment-query", async () => ({ success: true, experiments: [] }));
    sdk.fns.set("mem::artifact-query", async () => ({ success: true, artifacts: [] }));
    sdk.fns.set("mem::negative-memory-lookup", async () => ({
      success: true,
      negativeMemories: [],
      shouldNotRetry: false,
    }));
    sdk.fns.set("mem::evidence-query", async () => ({
      success: true,
      evidence: [{
        id: "evd_public",
        kind: "test-log",
        source: "vitest",
        locator: "test/planned-retrieval.test.ts:240",
        content: "PRIVATE EVIDENCE BODY",
        capturedAt: "2026-01-01T00:00:00Z",
        provenance: { channel: "tool", capturedAt: "2026-01-01T00:00:00Z" },
        project: PROJECT,
        agentId: AGENT,
        score: 1,
      }],
    }));
    registerPlannedRetrievalFunctions(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-plan", {
      query: "test-log evidence",
      project: PROJECT,
      agentId: AGENT,
      budgets: { direct: 500, supporting: 0, historical: 0, provenance: 500 },
    })) as PlannedRetrievalResponse;

    const evidenceResult = result.results.find((entry) => entry.id === "evd_public")!;
    expect(evidenceResult.metadata?.evidence).toMatchObject({
      ids: ["evd_public"],
      summaries: [{ id: "evd_public", kind: "test-log", source: "vitest" }],
    });
    expect(JSON.stringify(result.results)).not.toContain("PRIVATE EVIDENCE BODY");
    expect(JSON.stringify(result.context)).not.toContain("PRIVATE EVIDENCE BODY");
    expect(result.context.tiers.direct.find((entry) => entry.id === "evidence:evd_public")?.content)
      .toContain("evd_public");
    const handle = result.handles.find((entry) => entry.itemId === "evidence:evd_public")!;
    const expanded = await sdk.trigger("mem::retrieval-expand", {
      handle: handle.handle,
      project: PROJECT,
      agentId: AGENT,
      tokenBudget: 1_000,
    }) as { success: boolean; expansion?: { content: string } };
    expect(expanded.success).toBe(true);
    expect(expanded.expansion?.content).toContain("PRIVATE EVIDENCE BODY");
  });

  it("treats wildcard agent scope as an explicit cross-agent read", async () => {
    const calls: Array<{ functionId: string; payload: Record<string, unknown> }> = [];
    for (const [functionId, field] of [
      ["mem::experiment-query", "experiments"],
      ["mem::artifact-query", "artifacts"],
      ["mem::evidence-query", "evidence"],
      ["mem::negative-memory-lookup", "negativeMemories"],
    ] as const) {
      sdk.fns.set(functionId, async (payload) => {
        calls.push({ functionId, payload: payload as Record<string, unknown> });
        return {
          success: true,
          [field]: functionId === "mem::experiment-query"
            ? [
                { id: "exp_a", objective: "AuthService A", project: PROJECT, agentId: "agent-a", score: 1 },
                { id: "exp_b", objective: "AuthService B", project: PROJECT, agentId: "agent-b", score: 0.9 },
              ]
            : [],
          ...(field === "negativeMemories" ? { shouldNotRetry: false } : {}),
        };
      });
    }
    await kv.set(KV.memories, "mem_a", makeMemory("mem_a", "enabled"));
    await kv.set(KV.memories, "mem_b", { ...makeMemory("mem_b", "disabled"), agentId: "agent-b" });
    sdk.fns.set("mem::search", async () => ({ results: [] }));
    registerPlannedRetrievalFunctions(sdk as never, kv as never);

    const result = (await sdk.trigger("mem::retrieval-plan", {
      query: QUERY,
      project: PROJECT,
      agentId: "*",
      tokenBudget: 0,
    })) as PlannedRetrievalResponse;

    expect(result.results.map((entry) => entry.id)).toEqual(
      expect.arrayContaining(["exp_a", "exp_b", "mem_a", "mem_b"]),
    );
    expect(calls.every((call) => call.payload.agentId === "*")).toBe(true);
  });

  it("expires cached expansion state and reports unavailable providers without failing the plan", async () => {
    let timestamp = 1_700_000_000_000;
    await kv.set(KV.memories, "mem_stable", {
      ...makeMemory("mem_stable", "stable"),
      isLatest: true,
      temporal: undefined,
      content: "stable retrieval content that only expansion may return",
    });
    registerPlannedRetrievalFunctions(sdk as never, kv as never, {
      cacheTtlMs: 5,
      now: () => timestamp,
    });

    const plan = (await sdk.trigger("mem::retrieval-plan", {
      query: "stable",
      project: PROJECT,
      agentId: AGENT,
      tokenBudget: 0,
    })) as PlannedRetrievalResponse;
    expect(plan.success).toBe(true);
    expect(plan.coverage).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          source: "hybrid",
          available: false,
          error: "No function: mem::search",
        }),
        expect.objectContaining({ source: "experiments", available: false }),
        expect.objectContaining({ source: "artifacts", available: false }),
        expect.objectContaining({ source: "evidence", available: false }),
        expect.objectContaining({ source: "negative_memories", available: false }),
      ]),
    );
    expect(plan.handles).toHaveLength(1);

    timestamp += 6;
    const expired = await sdk.trigger("mem::retrieval-expand", {
      handle: plan.handles[0].handle,
      project: PROJECT,
      agentId: AGENT,
    }) as { success: boolean; error?: string };
    expect(expired).toEqual({
      success: false,
      error: "retrieval expansion handle not found or expired",
    });
  });
});
