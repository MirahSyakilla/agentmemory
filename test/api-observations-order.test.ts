import { describe, expect, it, vi } from "vitest";
import { registerApiTriggers, sortObservationsNewestFirst } from "../src/triggers/api.js";

describe("sortObservationsNewestFirst", () => {
  it("orders observations newest-first by timestamp", () => {
    const observations = [
      { id: "obs-old", timestamp: "2026-06-16T05:10:43.149Z" },
      { id: "obs-new", timestamp: "2026-06-16T13:29:42.791Z" },
      { id: "obs-mid", timestamp: "2026-06-16T13:19:00.730Z" },
    ];

    const out = sortObservationsNewestFirst(observations).map((o) => o.id);

    expect(out).toEqual(["obs-new", "obs-mid", "obs-old"]);
  });

  it("uses id as a stable tie-breaker when timestamps match", () => {
    const observations = [
      { id: "obs-000001", timestamp: "2026-06-16T13:29:42.791Z" },
      { id: "obs-000003", timestamp: "2026-06-16T13:29:42.791Z" },
      { id: "obs-000002", timestamp: "2026-06-16T13:29:42.791Z" },
    ];

    const out = sortObservationsNewestFirst(observations).map((o) => o.id);

    expect(out).toEqual(["obs-000003", "obs-000002", "obs-000001"]);
  });
});

describe("api::observations pagination", () => {
  function makeObservations(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      id: `obs-${String(i).padStart(3, "0")}`,
      sessionId: "session-1",
      timestamp: new Date(1_800_000_000_000 + i * 1000).toISOString(),
    }));
  }

  function registerHandler(observations: ReturnType<typeof makeObservations>) {
    const handlers = new Map<string, (req: unknown) => Promise<unknown>>();
    const sdk = {
      registerFunction: vi.fn((id: string, handler: (req: unknown) => Promise<unknown>) => {
        handlers.set(id, handler);
      }),
      registerTrigger: vi.fn(),
      trigger: vi.fn(),
    };
    const kv = {
      list: vi.fn(async () => observations),
      get: vi.fn(async () => null),
    };
    registerApiTriggers(sdk as never, kv as never);
    const handler = handlers.get("api::observations");
    expect(handler).toBeDefined();
    return handler!;
  }

  it("defaults to a bounded newest-first page", async () => {
    const handler = registerHandler(makeObservations(600));

    const res = (await handler({
      query_params: { sessionId: "session-1" },
    })) as { status_code: number; body: { observations: Array<{ id: string }>; total: number; limit: number; offset: number; hasMore: boolean } };

    expect(res.status_code).toBe(200);
    expect(res.body.observations).toHaveLength(500);
    expect(res.body.observations[0].id).toBe("obs-599");
    expect(res.body.total).toBe(600);
    expect(res.body.limit).toBe(500);
    expect(res.body.offset).toBe(0);
    expect(res.body.hasMore).toBe(true);
  });

  it("supports explicit limit and offset", async () => {
    const handler = registerHandler(makeObservations(600));

    const res = (await handler({
      query_params: { sessionId: "session-1", limit: "25", offset: "575" },
    })) as { status_code: number; body: { observations: Array<{ id: string }>; total: number; limit: number; offset: number; hasMore: boolean } };

    expect(res.status_code).toBe(200);
    expect(res.body.observations).toHaveLength(25);
    expect(res.body.observations[0].id).toBe("obs-024");
    expect(res.body.observations[24].id).toBe("obs-000");
    expect(res.body.total).toBe(600);
    expect(res.body.limit).toBe(25);
    expect(res.body.offset).toBe(575);
    expect(res.body.hasMore).toBe(false);
  });

  it("returns totals without observation payloads for count=true", async () => {
    const handler = registerHandler(makeObservations(600));

    const res = (await handler({
      query_params: { sessionId: "session-1", count: "true" },
    })) as { status_code: number; body: { observations: unknown[]; total: number; limit: number; offset: number; hasMore: boolean } };

    expect(res.status_code).toBe(200);
    expect(res.body.observations).toEqual([]);
    expect(res.body.total).toBe(600);
    expect(res.body.limit).toBe(0);
    expect(res.body.offset).toBe(0);
    expect(res.body.hasMore).toBe(true);
  });
});
