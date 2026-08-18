import { describe, expect, it, vi } from "vitest";
import {
  registerContextReductionFunctions,
  summarizeContextReductionEvents,
} from "../src/functions/context-reduction.js";
import { registerContextFunction } from "../src/functions/context.js";
import { KV } from "../src/state/schema.js";
import type { ContextReductionEvent } from "../src/types.js";
import { createContextDeliveryAccounting } from "../src/utils/token-estimate.js";

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  return {
    get: async <T>(scope: string, key: string): Promise<T | null> =>
      (store.get(scope)?.get(key) as T) ?? null,
    set: async <T>(scope: string, key: string, value: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, value);
      return value;
    },
    list: async <T>(scope: string): Promise<T[]> =>
      (Array.from(store.get(scope)?.values() ?? []) as T[]),
    store,
  };
}

function wire(kv: ReturnType<typeof mockKV>) {
  const handlers = new Map<string, (data: any) => Promise<any>>();
  const sdk = {
    registerFunction: vi.fn((id: string, handler: (data: any) => Promise<any>) => {
      handlers.set(id, handler);
    }),
  };
  registerContextReductionFunctions(sdk as never, kv as never);
  return handlers;
}

describe("context reduction accounting", () => {
  it("treats explicit MCP retrieval as added model-visible context", () => {
    const text = JSON.stringify({ results: [{ title: "Earlier decision" }] }, null, 2);
    const accounting = createContextDeliveryAccounting(text);

    expect(accounting.baselineTokens).toBe(0);
    expect(accounting.returnedTokens).toBe(Math.ceil(text.length / 3));
    expect(accounting.tokenDelta).toBe(-accounting.returnedTokens);
  });

  it("compares the exact returned payload with the full eligible block set", async () => {
    const kv = mockKV();
    await kv.set(KV.sessions, "old-1", {
      id: "old-1",
      project: "project-a",
      cwd: "/tmp/project-a",
      startedAt: "2026-07-16T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
    });
    await kv.set(KV.sessions, "old-2", {
      id: "old-2",
      project: "project-a",
      cwd: "/tmp/project-a",
      startedAt: "2026-07-17T00:00:00.000Z",
      status: "completed",
      observationCount: 1,
    });
    for (const id of ["old-1", "old-2"]) {
      await kv.set(KV.summaries, id, {
        sessionId: id,
        project: "project-a",
        createdAt: `${id === "old-1" ? "2026-07-16" : "2026-07-17"}T01:00:00.000Z`,
        title: `Summary ${id}`,
        narrative: "x".repeat(300),
        keyDecisions: [],
        filesModified: [],
        concepts: [],
        observationCount: 1,
      });
    }
    let handler: ((data: any) => Promise<any>) | undefined;
    const sdk = {
      registerFunction: vi.fn((id: string, fn: (data: any) => Promise<any>) => {
        if (id === "mem::context") handler = fn;
      }),
    };
    registerContextFunction(sdk as never, kv as never, 150);

    const result = await handler!({
      sessionId: "current",
      project: "project-a",
    });
    expect(result.blocks).toBe(1);
    expect(result.accounting.returnedTokens).toBe(result.tokens);
    expect(result.accounting.baselineTokens).toBeGreaterThan(result.tokens);
    expect(result.accounting.tokenDelta).toBe(
      result.accounting.baselineTokens - result.accounting.returnedTokens,
    );
  });

  it("records each emitted context once and aggregates its real delta", async () => {
    const kv = mockKV();
    const handlers = wire(kv);
    const record = handlers.get("mem::context-reduction-record")!;
    const stats = handlers.get("mem::context-reduction-stats")!;
    const payload = {
      accounting: {
        eventId: "ctxred_one",
        estimator: "chars_div_3_v1",
        baselineTokens: 900,
        returnedTokens: 300,
        tokenDelta: 600,
      },
      source: "session_start",
      sessionId: "session-1",
      project: "project-a",
    };

    expect((await record(payload)).deduplicated).toBe(false);
    expect((await record(payload)).deduplicated).toBe(true);
    const recallText = JSON.stringify({ results: [{ title: "Focused result" }] }, null, 2);
    await record({
      accounting: createContextDeliveryAccounting(recallText),
      source: "mcp_recall",
      project: "project-a",
    });

    const result = await stats({});
    expect(result.measuredEvents).toBe(1);
    expect(result.baselineTokens).toBe(900);
    expect(result.returnedTokens).toBe(300);
    expect(result.tokenDelta).toBe(600);
    expect(result.reductionPercent).toBe(66.7);
    expect(result.bySource.session_start).toMatchObject({
      measuredEvents: 1,
      tokenDelta: 600,
    });
    expect(result.automaticInjection).toMatchObject({
      measuredEvents: 1,
      returnedTokens: 300,
    });
    expect(result.onDemandRecall).toMatchObject({
      measuredEvents: 1,
      returnedTokens: Math.ceil(recallText.length / 3),
    });
    expect(result.bySource.mcp_recall).toMatchObject({ measuredEvents: 1 });
    expect(await kv.get(KV.contextReductionEvents, "ctxred_one")).not.toBeNull();
  });

  it("preserves negative deltas instead of presenting overhead as savings", () => {
    const events: ContextReductionEvent[] = [
      {
        eventId: "ctxred_negative",
        estimator: "chars_div_3_v1",
        baselineTokens: 120,
        returnedTokens: 180,
        tokenDelta: -60,
        source: "pre_tool_use",
        timestamp: "2026-07-18T00:00:00.000Z",
        project: "project-a",
      },
    ];

    const result = summarizeContextReductionEvents(events, "project-a");
    expect(result.tokenDelta).toBe(-60);
    expect(result.reductionPercent).toBe(-50);
  });

  it("rejects malformed accounting at the function boundary", async () => {
    const handlers = wire(mockKV());
    const record = handlers.get("mem::context-reduction-record")!;
    await expect(
      record({
        accounting: {
          eventId: "bad",
          estimator: "chars_div_3_v1",
          baselineTokens: 100,
          returnedTokens: 10,
          tokenDelta: 999,
        },
        source: "session_start",
      }),
    ).resolves.toMatchObject({ success: false });
  });
});
