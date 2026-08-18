import { describe, expect, it, vi } from "vitest";
import { registerFinalizeIdleSessionsFunction } from "../src/functions/finalize-idle-sessions.js";
import { KV } from "../src/state/schema.js";
import type { Session, SessionSummary } from "../src/types.js";

type Handler = (data?: Record<string, unknown>) => Promise<Record<string, unknown>>;

function makeSession(overrides: Partial<Session> = {}): Session {
  return {
    id: "session-1",
    project: "agentmemory",
    cwd: "/home/meow/agentmemory",
    startedAt: "2026-07-18T00:00:00.000Z",
    updatedAt: "2026-07-18T01:00:00.000Z",
    status: "active",
    observationCount: 5,
    ...overrides,
  };
}

function makeSummary(overrides: Partial<SessionSummary> = {}): SessionSummary {
  return {
    sessionId: "session-1",
    project: "agentmemory",
    createdAt: "2026-07-18T01:00:00.000Z",
    title: "Summary",
    narrative: "Summary narrative",
    keyDecisions: [],
    filesModified: [],
    concepts: [],
    observationCount: 5,
    ...overrides,
  };
}

function createHarness(
  initialSessions: Session[],
  initialSummaries: SessionSummary[] = [],
) {
  const functions = new Map<string, Handler>();
  const sessions = new Map(initialSessions.map((session) => [session.id, session]));
  const summaries = new Map(
    initialSummaries.map((summary) => [summary.sessionId, summary]),
  );
  const audits = new Map<string, unknown>();

  const sdk = {
    registerFunction: vi.fn((id: string, handler: Handler) => {
      functions.set(id, handler);
    }),
    trigger: vi.fn(async (request: { function_id: string; payload: unknown }) => {
      if (request.function_id === "event::session::stopped") {
        return { success: true };
      }
      const handler = functions.get(request.function_id);
      if (!handler) throw new Error("No function: " + request.function_id);
      return handler(request.payload as Record<string, unknown>);
    }),
  };

  const kv = {
    list: vi.fn(async (scope: string) => {
      if (scope === KV.sessions) return [...sessions.values()];
      if (scope === KV.audit) return [...audits.values()];
      return [];
    }),
    get: vi.fn(async (scope: string, key: string) => {
      if (scope === KV.sessions) return sessions.get(key) ?? null;
      if (scope === KV.summaries) return summaries.get(key) ?? null;
      if (scope === KV.audit) return audits.get(key) ?? null;
      return null;
    }),
    set: vi.fn(async (scope: string, key: string, value: unknown) => {
      if (scope === KV.sessions) sessions.set(key, value as Session);
      if (scope === KV.summaries) summaries.set(key, value as SessionSummary);
      if (scope === KV.audit) audits.set(key, value);
      return value;
    }),
    update: vi.fn(
      async (
        scope: string,
        key: string,
        ops: Array<{ type: string; path: string; value?: unknown }>,
      ) => {
        if (scope !== KV.sessions) return null;
        const current = sessions.get(key);
        if (!current) return null;
        const next = { ...current } as Record<string, unknown>;
        for (const op of ops) {
          if (op.type === "set") next[op.path] = op.value;
        }
        sessions.set(key, next as unknown as Session);
        return next;
      },
    ),
  };

  registerFinalizeIdleSessionsFunction(sdk as never, kv as never);
  const run = functions.get("mem::finalize-idle-sessions");
  if (!run) throw new Error("finalizer was not registered");
  return { audits, kv, run, sdk, sessions };
}

describe("mem::finalize-idle-sessions", () => {
  it("completes an idle session at its last activity without losing history", async () => {
    const session = makeSession({
      firstPrompt: "Keep this prompt",
      summary: "Keep this title",
    });
    const { audits, run, sdk, sessions } = createHarness([session]);

    const result = await run({
      now: "2026-07-20T02:00:00.000Z",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      success: true,
      finalized: 1,
      summaryRefreshQueued: 1,
      sessionIds: ["session-1"],
    });
    expect(sessions.get("session-1")).toMatchObject({
      status: "completed",
      endedAt: "2026-07-18T01:00:00.000Z",
      startedAt: "2026-07-18T00:00:00.000Z",
      observationCount: 5,
      firstPrompt: "Keep this prompt",
      summary: "Keep this title",
    });
    expect(sdk.trigger).toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "event::session::stopped",
        payload: { sessionId: "session-1" },
      }),
    );
    expect([...audits.values()]).toContainEqual(
      expect.objectContaining({
        operation: "session_finalize",
        targetIds: ["session-1"],
      }),
    );
  });

  it("keeps a long-lived session active when updated recently", async () => {
    const { run, sessions } = createHarness([
      makeSession({
        startedAt: "2026-07-01T00:00:00.000Z",
        updatedAt: "2026-07-20T01:30:00.000Z",
      }),
    ]);

    const result = await run({
      now: "2026-07-20T02:00:00.000Z",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({ finalized: 0, candidates: 0 });
    expect(sessions.get("session-1")?.status).toBe("active");
  });

  it("rechecks activity before finalizing a previously stale candidate", async () => {
    const staleSnapshot = makeSession();
    const { kv, run, sessions } = createHarness([staleSnapshot]);
    sessions.set(
      "session-1",
      makeSession({ updatedAt: "2026-07-20T01:30:00.000Z" }),
    );
    kv.list.mockResolvedValueOnce([staleSnapshot]);

    const result = await run({
      now: "2026-07-20T02:00:00.000Z",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      candidates: 1,
      finalized: 0,
      skipped: 1,
    });
    expect(sessions.get("session-1")?.status).toBe("active");
  });

  it("does not queue a summary refresh when the stored summary is current", async () => {
    const { run, sdk } = createHarness([makeSession()], [makeSummary()]);

    const result = await run({
      now: "2026-07-20T02:00:00.000Z",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      finalized: 1,
      summaryRefreshQueued: 0,
    });
    expect(sdk.trigger).not.toHaveBeenCalledWith(
      expect.objectContaining({
        function_id: "event::session::stopped",
      }),
    );
  });

  it("previews stale sessions without changing state", async () => {
    const { audits, kv, run, sessions } = createHarness([makeSession()]);

    const result = await run({
      dryRun: true,
      now: "2026-07-20T02:00:00.000Z",
      idleTimeoutMs: 24 * 60 * 60 * 1000,
    });

    expect(result).toMatchObject({
      dryRun: true,
      finalized: 1,
      sessionIds: ["session-1"],
    });
    expect(sessions.get("session-1")?.status).toBe("active");
    expect(kv.update).not.toHaveBeenCalled();
    expect(audits.size).toBe(0);
  });

  it("rejects an invalid clock value", async () => {
    const { run } = createHarness([makeSession()]);

    await expect(run({ now: "not-a-date" })).resolves.toEqual({
      success: false,
      error: "now must be a valid ISO timestamp",
    });
  });
});
