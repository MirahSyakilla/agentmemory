import { describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";

function createHarness(results: {
  search?: unknown;
  smartSearch?: unknown;
}) {
  const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
  const deliveries: Array<Record<string, unknown>> = [];
  const trigger = vi.fn(async (input: {
    function_id: string;
    payload: Record<string, unknown>;
  }) => {
    if (input.function_id === "mem::search") return results.search;
    if (input.function_id === "mem::smart-search") return results.smartSearch;
    if (input.function_id === "mem::context-reduction-record") {
      deliveries.push(input.payload);
      return { success: true };
    }
    throw new Error(`Unexpected function: ${input.function_id}`);
  });
  const sdk = {
    registerFunction: vi.fn((id: string, handler: (req: unknown) => Promise<unknown>) => {
      handlers.set(id, handler);
    }),
    registerTrigger: vi.fn(),
    trigger,
  };
  registerMcpEndpoints(sdk as never, {} as never);
  const call = handlers.get("mcp::tools::call");
  if (!call) throw new Error("MCP call handler was not registered");
  return { call, deliveries, trigger };
}

function expectDelivery(
  delivery: Record<string, unknown>,
  source: string,
  text: string,
  project: string,
) {
  const accounting = delivery.accounting as Record<string, unknown>;
  const tokens = Math.ceil(text.length / 3);
  expect(delivery.source).toBe(source);
  expect(delivery.project).toBe(project);
  expect(accounting.baselineTokens).toBe(0);
  expect(accounting.returnedTokens).toBe(tokens);
  expect(accounting.tokenDelta).toBe(-tokens);
}

describe("MCP model-visible context delivery accounting", () => {
  it("records the exact serialized memory_recall response after filtering by project", async () => {
    const result = { format: "full", results: [{ observation: { title: "Past decision" } }] };
    const { call, deliveries, trigger } = createHarness({ search: result });

    const response = (await call({
      body: {
        name: "memory_recall",
        arguments: { query: "decision", project: "project-a", agentId: "agent-a" },
      },
    })) as { body: { content: Array<{ text: string }> } };
    const text = response.body.content[0].text;

    expectDelivery(deliveries[0]!, "mcp_recall", text, "project-a");
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::search",
       payload: expect.objectContaining({ project: "project-a", agentId: "agent-a" }),
    });
  });

  it("records the exact serialized memory_smart_search response after filtering by project", async () => {
    const result = { mode: "compact", results: [{ title: "Prior fix" }] };
    const { call, deliveries, trigger } = createHarness({ smartSearch: result });

    const response = (await call({
      body: {
        name: "memory_smart_search",
        arguments: { query: "fix", project: "project-b", agentId: "agent-b" },
      },
    })) as { body: { content: Array<{ text: string }> } };
    const text = response.body.content[0].text;

    expectDelivery(deliveries[0]!, "mcp_smart_search", text, "project-b");
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::smart-search",
       payload: expect.objectContaining({ project: "project-b", agentId: "agent-b" }),
    });
  });
});
