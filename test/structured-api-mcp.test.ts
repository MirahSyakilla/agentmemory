import { describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";
import { registerApiTriggers } from "../src/triggers/api.js";

type Handler = (input: unknown) => Promise<unknown> | unknown;

function createSdk() {
  const functions = new Map<string, Handler>();
  const triggers: Array<{ functionId: string; path?: string }> = [];
  const sdk = {
    registerFunction: (id: string, handler: Handler) => functions.set(id, handler),
    registerTrigger: (trigger: { function_id: string; config?: { api_path?: string } }) => {
      triggers.push({ functionId: trigger.function_id, path: trigger.config?.api_path });
    },
    trigger: vi.fn(async (input: { function_id: string; payload: unknown }) => {
      const handler = functions.get(input.function_id);
      if (!handler) throw new Error(`No function: ${input.function_id}`);
      return handler(input.payload);
    }),
  };
  return { sdk, functions, triggers };
}

describe("structured record public surfaces", () => {
  it("whitelists REST evidence writes and registers the planned retrieval endpoints", async () => {
    const { sdk, functions, triggers } = createSdk();
    let captured: Record<string, unknown> | undefined;
    functions.set("mem::evidence-write", async (payload) => {
      captured = payload as Record<string, unknown>;
      return { success: true, evidence: { id: "evd_1" } };
    });
    registerApiTriggers(sdk as never, {} as never);

    const handler = functions.get("api::evidence-write")!;
    const response = (await handler({
      body: {
        kind: "log",
        provenance: { channel: "tool", capturedAt: "2026-08-19T00:00:00.000Z" },
        project: "agentmemory",
        unknown: "must not reach the memory function",
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(201);
    expect(captured).toEqual({
      kind: "log",
      provenance: { channel: "tool", capturedAt: "2026-08-19T00:00:00.000Z" },
      project: "agentmemory",
    });
    expect(triggers.map((trigger) => trigger.path)).toContain(
      "/agentmemory/retrieval/plan",
    );
    expect(triggers.map((trigger) => trigger.path)).toContain(
      "/agentmemory/graph/temporal-query",
    );
  });

  it("routes bounded graph observation-index backfill options without passing raw input", async () => {
    const { sdk, functions } = createSdk();
    let captured: Record<string, unknown> | undefined;
    functions.set("mem::graph-observation-index-backfill", async (payload) => {
      captured = payload as Record<string, unknown>;
      return { success: true, complete: false };
    });
    registerApiTriggers(sdk as never, {} as never);

    const response = (await functions.get("api::graph-snapshot-rebuild")!({
      body: {
        backfill: true,
        reset: true,
        pageSize: 10,
        maxPages: 2,
        unexpected: "must not reach the graph function",
      },
    })) as { status_code: number };

    expect(response.status_code).toBe(200);
    expect(captured).toEqual({ reset: true, pageSize: 10, maxPages: 2 });
  });

  it("forwards only supported MCP arguments to planned retrieval and keeps scope", async () => {
    const { sdk, functions } = createSdk();
    let captured: Record<string, unknown> | undefined;
    functions.set("mem::retrieval-plan", async (payload) => {
      captured = payload as Record<string, unknown>;
      return { success: true, handles: [], results: [] };
    });
    registerMcpEndpoints(sdk as never, {} as never);

    const handler = functions.get("mcp::tools::call")!;
    const response = (await handler({
      body: {
        name: "memory_retrieval_plan",
        arguments: {
          query: "find evidence for auth",
          project: "agentmemory",
          agentId: "codex",
          tokenBudget: 300,
          budgets: { direct: 200, provenance: 100 },
          unsupported: "must not reach the memory function",
        },
      },
    })) as { status_code: number; body: { content: Array<{ text: string }> } };

    expect(response.status_code).toBe(200);
    expect(captured).toEqual({
      query: "find evidence for auth",
      project: "agentmemory",
      agentId: "codex",
      tokenBudget: 300,
      budgets: { direct: 200, provenance: 100 },
    });
    expect(JSON.parse(response.body.content[0].text)).toEqual({
      success: true,
      handles: [],
      results: [],
    });
  });

  it("requires the durable conflict resolution fields in the MCP surface", async () => {
    const { sdk, functions } = createSdk();
    registerMcpEndpoints(sdk as never, {} as never);

    const handler = functions.get("mcp::tools::call")!;
    const response = (await handler({
      body: { name: "memory_conflict_resolve", arguments: { conflictId: "conf_1" } },
    })) as { status_code: number; body: { error: string } };

    expect(response.status_code).toBe(400);
    expect(response.body.error).toContain("conflictId and status");
  });

  it("forwards experiment link IDs through the existing REST and MCP operations", async () => {
    const { sdk, functions } = createSdk();
    const captured: Record<string, unknown>[] = [];
    functions.set("mem::experiment-create", async (payload) => {
      captured.push(payload as Record<string, unknown>);
      return { success: true };
    });
    functions.set("mem::experiment-update", async (payload) => {
      captured.push(payload as Record<string, unknown>);
      return { success: true };
    });
    registerApiTriggers(sdk as never, {} as never);
    registerMcpEndpoints(sdk as never, {} as never);

    const apiResponse = (await functions.get("api::experiment-create")!({
      body: {
        objective: "Link records",
        provenance: { channel: "tool", capturedAt: "2026-08-19T00:00:00.000Z" },
        graphNodeIds: ["gn_1"],
        negativeMemoryIds: ["neg_1"],
        authority: { source: "user", confidence: 1 },
        unsupported: "not forwarded",
      },
    })) as { status_code: number };
    expect(apiResponse.status_code).toBe(201);
    expect(captured[0]).toEqual({
      objective: "Link records",
      provenance: { channel: "tool", capturedAt: "2026-08-19T00:00:00.000Z" },
      graphNodeIds: ["gn_1"],
      negativeMemoryIds: ["neg_1"],
      authority: { source: "user", confidence: 1 },
    });

    const mcpResponse = (await functions.get("mcp::tools::call")!({
      body: {
        name: "memory_experiment_update",
        arguments: {
          id: "exp_1",
          actionIds: ["act_1"],
          sessionIds: ["ses_1"],
          observationIds: ["obs_1"],
          graphNodeIds: ["gn_1"],
          negativeMemoryIds: ["neg_1"],
          unsupported: "not forwarded",
        },
      },
    })) as { status_code: number };
    expect(mcpResponse.status_code).toBe(200);
    expect(captured[1]).toEqual({
      id: "exp_1",
      actionIds: ["act_1"],
      sessionIds: ["ses_1"],
      observationIds: ["obs_1"],
      graphNodeIds: ["gn_1"],
      negativeMemoryIds: ["neg_1"],
    });
  });
});
