import { describe, expect, it, vi } from "vitest";
import { registerContextFunction } from "../src/functions/context.js";

function mockKV() {
  return {
    get: async () => null,
    list: async () => [],
    set: async <T>(_scope: string, _key: string, value: T) => value,
  };
}

describe("mem::context planned retrieval", () => {
  it("uses an opening task query to include budgeted planned context", async () => {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const trigger = vi.fn(async (input: { function_id: string; payload: Record<string, unknown> }) => {
      if (input.function_id !== "mem::retrieval-plan") {
        throw new Error(`Unexpected function: ${input.function_id}`);
      }
      return {
        success: true,
        context: {
          tiers: {
            direct: [{ title: "Prior fix", content: "Use the verified migration.", tokens: 8 }],
            supporting: [],
            historical: [],
            provenance: [{ title: "Proof", content: "origin=tool", tokens: 4 }],
          },
        },
      };
    });
    const sdk = {
      registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => {
        handlers.set(id, handler);
      },
      trigger,
    };
    registerContextFunction(sdk as never, mockKV() as never, 1_000);

    const handler = handlers.get("mem::context")!;
    const result = (await handler({
      sessionId: "ses_1",
      project: "agentmemory",
      agentId: "opencode",
      query: "migrate the evidence store",
    })) as { context: string };

    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::retrieval-plan",
      payload: {
        query: "migrate the evidence store",
        project: "agentmemory",
        agentId: "opencode",
        tokenBudget: 350,
      },
    });
    expect(result.context).toContain("Retrieved Context: Prior fix");
    expect(result.context).toContain("Evidence And Provenance: Proof");
  });

  it("keeps legacy context available when planned retrieval is unavailable", async () => {
    const handlers = new Map<string, (payload: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: (id: string, handler: (payload: unknown) => Promise<unknown>) => {
        handlers.set(id, handler);
      },
      trigger: async () => {
        throw new Error("planned retrieval unavailable");
      },
    };
    registerContextFunction(sdk as never, mockKV() as never, 1_000);

    const handler = handlers.get("mem::context")!;
    const result = (await handler({
      sessionId: "ses_1",
      project: "agentmemory",
      query: "migrate the evidence store",
    })) as { context: string; blocks: number };

    expect(result.context).toBe("");
    expect(result.blocks).toBe(0);
  });
});
