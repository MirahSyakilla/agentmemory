import { describe, expect, it } from "vitest";
import { KV } from "../src/state/schema.js";
import {
  DeterministicRetrievalPlanner,
  createDefaultRetrievalPlannerAdapters,
  deriveRetrievalRequirements,
  type RetrievalRequest,
} from "../src/functions/retrieval-planner.js";

describe("deterministic retrieval planner", () => {
  it("derives entities and temporal, evidence, and negative requirements without model calls", () => {
    const query =
      'Show "AuthService" in src/auth.ts as of 2026-03-01 with evidence, without Redis -memcache';

    expect(deriveRetrievalRequirements(query)).toEqual({
      intent: "timeline",
      entities: ["AuthService", "src/auth.ts"],
      temporal: { mode: "as_of", asOf: "2026-03-01" },
      evidenceRequired: true,
      negativeTerms: ["memcache", "Redis"],
    });
  });

  it("forwards scope to hybrid, graph, and memory retrieval and partitions all context tiers", async () => {
    const received: RetrievalRequest[] = [];
    const capture = <T>(result: T) => async (request: RetrievalRequest): Promise<T> => {
      received.push(request);
      return result;
    };
    const planner = new DeterministicRetrievalPlanner({
      hybrid: capture([
        {
          id: "active",
          title: "AuthService status",
          content: "The authentication service is enabled.",
          score: 0.9,
          project: "agentmemory",
          agentId: "planner-agent",
          claims: { status: "enabled" },
          sourceObservationIds: ["obs_active"],
        },
        {
          id: "negative",
          title: "Redis cache work",
          content: "AuthService used a Redis cache in an abandoned branch.",
          score: 0.8,
          project: "agentmemory",
          agentId: "planner-agent",
        },
        {
          id: "wrong-project",
          title: "Other project result",
          content: "This must not be returned.",
          score: 1,
          project: "other",
          agentId: "planner-agent",
        },
      ]),
      graph: capture([
        {
          id: "support",
          title: "AuthService graph relation",
          content: "The service depends on the session validator.",
          score: 0.7,
          project: "agentmemory",
          agentId: "planner-agent",
          claims: { status: "disabled" },
          graphContext: "AuthService --depends_on--> SessionValidator",
          sourceObservationIds: ["obs_support"],
        },
      ]),
      memory: capture([
        {
          id: "history",
          title: "Previous AuthService deployment",
          content: "The service was disabled before the rollout.",
          score: 0.6,
          project: "agentmemory",
          agentId: "planner-agent",
          historical: true,
          sourceObservationIds: ["obs_history"],
        },
      ]),
    });

    const plan = await planner.plan({
      query: 'What is "AuthService" with evidence without Redis?',
      project: "agentmemory",
      agentId: "planner-agent",
      budgets: { direct: 500, supporting: 500, historical: 500, provenance: 500 },
    });

    expect(received).toHaveLength(3);
    expect(received.every((request) => request.scope.project === "agentmemory")).toBe(true);
    expect(received.every((request) => request.scope.agentId === "planner-agent")).toBe(true);
    expect(received.every((request) => request.entities.includes("AuthService"))).toBe(true);
    expect(plan.results.map((result) => result.id)).toEqual([
      "active",
      "negative",
      "support",
      "history",
    ]);
    expect(plan.context.tiers.direct.map((item) => item.id)).toEqual(["active", "negative"]);
    expect(plan.context.tiers.supporting.map((item) => item.id)).toEqual(["support"]);
    expect(plan.context.tiers.historical.map((item) => item.id)).toEqual(["history"]);
    expect(plan.context.tiers.provenance.map((item) => item.id)).toEqual([
      "provenance:active",
      "provenance:support",
      "provenance:history",
    ]);
    expect(plan.diagnostics.filteredByProject).toBe(1);
    expect(plan.diagnostics.negativeMatches).toEqual([
      { candidateId: "negative", terms: ["Redis"] },
    ]);
    expect(plan.diagnostics.conflicts).toEqual([
      {
        candidateIds: ["active", "support"],
        reason: "claim_value",
        claim: "status",
      },
    ]);
    expect(plan.diagnostics.conflictDetectionAvailable).toBe(true);
  });

  it("keeps omitted content expandable under the caller's token budget", async () => {
    const planner = new DeterministicRetrievalPlanner({
      hybrid: async () => [
        {
          id: "large",
          title: "Auth result",
          content: "A".repeat(300),
          score: 1,
          project: "agentmemory",
        },
      ],
    });

    const plan = await planner.plan({
      query: "Auth",
      project: "agentmemory",
      tokenBudget: 12,
      budgets: { direct: 12, supporting: 0, historical: 0, provenance: 0 },
    });
    const handle = plan.context.handles.find((entry) => entry.handle === "ctx:direct:large")!;

    expect(plan.context.tiers.direct).toEqual([]);
    expect(plan.context.omitted.direct).toEqual(["large"]);
    expect(plan.context.tokensUsed).toBe(0);
    expect(plan.results[0]).not.toHaveProperty("content");
    expect(planner.expand(plan, handle, 1_000)).toMatchObject({
      itemId: "large",
      content: expect.stringContaining("AAA"),
      truncated: false,
    });
  });

  it("preserves bounded origin and evidence metadata in results and context", async () => {
    const planner = new DeterministicRetrievalPlanner({
      hybrid: async () => [{
        id: "mem_provenance",
        title: "Auth result",
        content: "Auth was verified.",
        score: 1,
        project: "agentmemory",
        metadata: { kind: "memory" },
        retrievalMetadata: {
          origin: { channel: "tool", capturedAt: "2026-01-01T00:00:00Z" },
          evidence: {
            ids: ["evd_auth"],
            summaries: [{ id: "evd_auth", kind: "test-log", source: "vitest" }],
          },
        },
      }],
    });

    const plan = await planner.plan({
      query: "Auth with evidence",
      project: "agentmemory",
      budgets: { direct: 500, supporting: 0, historical: 0, provenance: 500 },
    });

    expect(plan.results[0]?.metadata).toEqual({
      origin: { channel: "tool", capturedAt: "2026-01-01T00:00:00Z" },
      evidence: {
        ids: ["evd_auth"],
        summaries: [{ id: "evd_auth", kind: "test-log", source: "vitest" }],
      },
    });
    expect(plan.context.tiers.direct[0]?.metadata).toMatchObject({
      origin: { channel: "tool" },
      evidence: { ids: ["evd_auth"] },
    });
    expect(plan.context.tiers.provenance[0]?.content).toContain("evd_auth");
  });

  it("caps evidence IDs and summaries at the retrieval result boundary", async () => {
    const ids = Array.from({ length: 12 }, (_, index) => `evd_${index}`);
    const planner = new DeterministicRetrievalPlanner({
      hybrid: async () => [{
        id: "bounded",
        title: "Bounded result",
        content: "A result with many evidence references.",
        score: 1,
        retrievalMetadata: {
          evidence: {
            ids,
            summaries: ids.map((id) => ({ id, kind: "log" })),
          },
        },
      }],
    });

    const plan = await planner.plan({ query: "bounded" });
    expect(plan.results[0]?.metadata?.evidence?.ids).toHaveLength(8);
    expect(plan.results[0]?.metadata?.evidence?.summaries).toHaveLength(8);
    expect(plan.results[0]?.metadata?.evidence?.truncated).toBe(true);
  });

  it("reports source failures instead of failing a retrieval plan", async () => {
    const planner = new DeterministicRetrievalPlanner({
      hybrid: async () => {
        throw new Error("hybrid unavailable");
      },
      memory: async () => [],
    });

    const plan = await planner.plan({ query: "plain query" });
    expect(plan.results).toEqual([]);
    expect(plan.diagnostics.sources).toContainEqual({
      source: "hybrid",
      available: true,
      requested: true,
      received: 0,
      error: "hybrid unavailable",
    });
    expect(plan.diagnostics.sources).toContainEqual({
      source: "graph",
      available: false,
      requested: false,
      received: 0,
    });
  });

  it("uses the existing hybrid search surface with project and agent scope in the default adapters", async () => {
    const calls: Array<{ function_id: string; payload: unknown }> = [];
    const sdk = {
      trigger: async (input: { function_id: string; payload: unknown }) => {
        calls.push(input);
        return { results: [] };
      },
    };
    const memory = {
      id: "mem_auth",
      createdAt: "2026-01-01T00:00:00Z",
      updatedAt: "2026-01-02T00:00:00Z",
      type: "fact" as const,
      title: "Auth convention",
      content: "Auth uses session rotation.",
      concepts: ["auth"],
      files: [],
      sessionIds: [],
      strength: 8,
      version: 1,
      isLatest: true,
      project: "agentmemory",
      agentId: "planner-agent",
    };
    const conflictingMemory = {
      ...memory,
      id: "mem_policy",
      title: "Auth policy",
      content: "Auth does not use session rotation.",
    };
    const relation = {
      type: "contradicts" as const,
      sourceId: memory.id,
      targetId: conflictingMemory.id,
      createdAt: "2026-01-03T00:00:00Z",
    };
    const kv = {
      get: async () => null,
      list: async <T>(scope: string): Promise<T[]> =>
        scope === KV.memories
          ? ([memory, conflictingMemory] as unknown as T[])
          : scope === KV.relations
            ? ([relation] as unknown as T[])
            : [],
    };
    const planner = new DeterministicRetrievalPlanner(
      createDefaultRetrievalPlannerAdapters(sdk, kv as never),
    );

    const plan = await planner.plan({
      query: "auth",
      project: "agentmemory",
      agentId: "planner-agent",
    });

    expect(calls).toEqual([
      {
        function_id: "mem::search",
        payload: {
          query: "auth",
          limit: 20,
          project: "agentmemory",
          agentId: "planner-agent",
          format: "full",
        },
      },
    ]);
    expect(plan.results.map((result) => result.id)).toEqual(["mem_auth", "mem_policy"]);
    expect(plan.diagnostics.conflicts).toEqual([
      {
        candidateIds: ["mem_auth", "mem_policy"],
        reason: "explicit_relation",
      },
    ]);
  });
});
