import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers } from "../src/triggers/api.js";
import { KV } from "../src/state/schema.js";

type Handler = (request: { body?: Record<string, unknown> }) => Promise<{
  status_code: number;
  body: Record<string, unknown>;
}>;

function registerHandlers(session: Record<string, unknown>) {
  const handlers = new Map<string, Handler>();
  const sdk = {
    registerFunction: vi.fn((id: string, handler: Handler) => {
      handlers.set(id, handler);
    }),
    registerTrigger: vi.fn(),
    trigger: vi.fn(async (request: { function_id: string; payload: unknown }) => {
      if (request.function_id === "mem::context") return { context: "" };
      if (request.function_id === "mem::observe") {
        return { success: true, observationId: "obs_turn_end" };
      }
      return { success: true };
    }),
  };
  const kv = {
    get: vi.fn(async () => session),
    set: vi.fn(async (_scope: string, _key: string, value: unknown) => value),
  };

  registerApiTriggers(sdk as never, kv as never);
  return { handlers, sdk, kv };
}

describe("Codex turn lifecycle", () => {
  it("checkpoints Stop without completing the thread session", async () => {
    const { handlers, sdk, kv } = registerHandlers({
      id: "ses_same_thread",
      project: "agentmemory",
      cwd: "/home/meow/agentmemory",
      startedAt: "2026-07-18T00:00:00.000Z",
      status: "active",
      observationCount: 5,
    });
    const handler = handlers.get("api::session::turn-end");
    expect(handler).toBeDefined();

    const response = await handler!({
      body: {
        sessionId: "ses_same_thread",
        project: "agentmemory",
        cwd: "/home/meow/agentmemory",
        timestamp: "2026-07-18T00:01:00.000Z",
        turnId: "turn_1",
        lastAssistantMessage: "Stopped after inspecting the issue.",
      },
    });

    expect(response.status_code).toBe(200);
    expect(sdk.trigger).toHaveBeenCalledWith(expect.objectContaining({
      function_id: "mem::observe",
      payload: expect.objectContaining({
        hookType: "stop",
        sessionId: "ses_same_thread",
      }),
    }));
    expect(sdk.trigger).not.toHaveBeenCalledWith(expect.objectContaining({
      function_id: "event::session::stopped",
      payload: { sessionId: "ses_same_thread" },
    }));
    expect(kv.set).not.toHaveBeenCalledWith(
      KV.sessions,
      "ses_same_thread",
      expect.objectContaining({ status: "completed" }),
    );
  });

  it("resumes a completed thread without resetting its session history", async () => {
    const { handlers, kv } = registerHandlers({
      id: "ses_same_thread",
      project: "agentmemory",
      cwd: "/home/meow/agentmemory",
      startedAt: "2026-07-18T00:00:00.000Z",
      endedAt: "2026-07-18T00:05:00.000Z",
      status: "completed",
      observationCount: 7,
      firstPrompt: "Original task",
    });
    const handler = handlers.get("api::session::start");
    expect(handler).toBeDefined();

    const response = await handler!({
      body: {
        sessionId: "ses_same_thread",
        project: "agentmemory",
        cwd: "/home/meow/agentmemory",
      },
    });

    expect(response.status_code).toBe(200);
    const saved = kv.set.mock.calls.find(
      ([scope, key]) => scope === KV.sessions && key === "ses_same_thread",
    )?.[2] as Record<string, unknown>;
    expect(saved.status).toBe("active");
    expect(saved.endedAt).toBeUndefined();
    expect(saved.startedAt).toBe("2026-07-18T00:00:00.000Z");
    expect(saved.observationCount).toBe(7);
    expect(saved.firstPrompt).toBe("Original task");
  });
});
