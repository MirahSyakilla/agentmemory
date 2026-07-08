import { afterEach, describe, expect, it, vi } from "vitest";
import { registerMcpEndpoints } from "../src/mcp/server.js";

vi.mock("../src/logger.js", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

function registerCallHandler(trigger: ReturnType<typeof vi.fn>) {
  const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
  const sdk = {
    registerFunction: vi.fn((id: string, handler: (req: unknown) => Promise<unknown>) => {
      handlers.set(id, handler);
    }),
    registerTrigger: vi.fn(),
    trigger,
  };
  registerMcpEndpoints(sdk as never, {} as never);
  const handler = handlers.get("mcp::tools::call");
  expect(handler).toBeDefined();
  return handler!;
}

describe("MCP memory_consolidate timeout boundary", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a background-running response before the MCP client timeout", async () => {
    vi.useFakeTimers();
    const trigger = vi.fn(() => new Promise(() => {}));
    const handler = registerCallHandler(trigger);

    const pending = handler({
      body: {
        name: "memory_consolidate",
        arguments: { tier: "semantic" },
      },
    }) as Promise<{ status_code: number; body: { content: Array<{ text: string }> } }>;

    await vi.advanceTimersByTimeAsync(12_000);
    const res = await pending;
    const body = JSON.parse(res.body.content[0].text);

    expect(res.status_code).toBe(200);
    expect(body).toMatchObject({
      success: true,
      running: true,
      tier: "semantic",
    });
    expect(trigger).toHaveBeenCalledWith({
      function_id: "mem::consolidate-pipeline",
      payload: { tier: "semantic" },
    });
  });

  it("returns the consolidation result when it finishes quickly", async () => {
    const trigger = vi.fn(async () => ({
      success: true,
      results: { semantic: { newFacts: 2 } },
    }));
    const handler = registerCallHandler(trigger);

    const res = (await handler({
      body: {
        name: "memory_consolidate",
        arguments: { tier: "semantic" },
      },
    })) as { status_code: number; body: { content: Array<{ text: string }> } };
    const body = JSON.parse(res.body.content[0].text);

    expect(res.status_code).toBe(200);
    expect(body).toEqual({
      success: true,
      results: { semantic: { newFacts: 2 } },
    });
  });
});
