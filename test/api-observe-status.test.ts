import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";

describe("api::observe status mapping", () => {
  it("returns 429 when mem::observe refuses a session limit write", async () => {
    const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (req: unknown) => Promise<unknown>) => {
        handlers.set(id, handler);
      }),
      registerTrigger: vi.fn(),
      trigger: vi.fn(async () => ({
        success: false,
        error: "Session observation limit reached (500)",
      })),
    };
    registerApiTriggers(sdk as never, {} as never);

    const handler = handlers.get("api::observe");
    expect(handler).toBeDefined();

    const res = (await handler!({
      body: {
        hookType: "post_tool_use",
        sessionId: "session-1",
        project: "project-1",
        cwd: "/tmp/project-1",
        timestamp: "2026-06-17T19:00:00.000Z",
        data: { tool_name: "shell_command" },
      },
    })) as { status_code: number; body: unknown };

    expect(res.status_code).toBe(429);
    expect(res.body).toEqual({
      success: false,
      error: "Session observation limit reached (500)",
    });
  });

  it("whitelists agent identity from hook payloads", async () => {
    const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (req: unknown) => Promise<unknown>) => {
        handlers.set(id, handler);
      }),
      registerTrigger: vi.fn(),
      trigger: vi.fn(async () => ({ success: true })),
    };
    registerApiTriggers(sdk as never, {} as never);
    const handler = handlers.get("api::observe")!;

    await handler({
      body: {
        hookType: "prompt_submit",
        sessionId: "session-1",
        project: "project-1",
        cwd: "/tmp/project-1",
        timestamp: "2026-06-17T19:00:00.000Z",
        agent_id: "codex",
        data: { prompt: "remember this" },
      },
    });

    expect(sdk.trigger).toHaveBeenCalledWith({
      function_id: "mem::observe",
      payload: expect.objectContaining({ agentId: "codex" }),
    });
  });
});
