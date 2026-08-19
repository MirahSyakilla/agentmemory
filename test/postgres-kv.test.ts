import { describe, expect, it, vi } from "vitest";
import type { ISdk } from "iii-sdk";
import type pg from "pg";
import { StateKV } from "../src/state/kv.js";
import type { StateKVBackend } from "../src/state/backend-kv.js";
import { PostgresKVBackend } from "../src/state/postgres-kv.js";

type Row = Record<string, unknown>;

class ConcurrentPool {
  readonly queries: string[] = [];
  private rows = new Map<string, unknown>();

  async query(sql: string, params: unknown[] = []): Promise<{ rows: Row[] }> {
    this.queries.push(sql);
    const normalized = sql.replace(/\s+/g, " ").trim().toLowerCase();
    if (normalized.startsWith("create table") || normalized.startsWith("create index")) {
      return { rows: [] };
    }
    if (normalized.startsWith("insert into agentmemory_kv") && normalized.includes("do nothing")) {
      await Promise.resolve();
      const rowKey = `${String(params[0])}\u0000${String(params[1])}`;
      if (this.rows.has(rowKey)) return { rows: [] };
      const value = JSON.parse(String(params[2]));
      this.rows.set(rowKey, value);
      return { rows: [{ value }] };
    }
    if (normalized.startsWith("select value from agentmemory_kv")) {
      const rowKey = `${String(params[0])}\u0000${String(params[1])}`;
      const value = this.rows.get(rowKey);
      return value === undefined ? { rows: [] } : { rows: [{ value }] };
    }
    throw new Error(`Unexpected SQL in test pool: ${sql}`);
  }

  async end(): Promise<void> {}
}

function postgresConfig() {
  return { connectionString: "postgres://test", ssl: false };
}

describe("PostgresKVBackend atomic claims", () => {
  it("allows exactly one concurrent claimant for a request key", async () => {
    const pool = new ConcurrentPool();
    const backend = new PostgresKVBackend(
      postgresConfig(),
      pool as unknown as pg.Pool,
    );

    const results = await Promise.all(
      Array.from({ length: 64 }, (_, owner) =>
        backend.claim("mem:request-ledger", "request-1", { owner }),
      ),
    );
    const winners = results.filter((result) => result.claimed);
    const winnerValue = winners[0]?.value;

    expect(winners).toHaveLength(1);
    expect(winnerValue).toBeDefined();
    expect(results.every((result) => result.value === winnerValue)).toBe(true);
    expect(
      pool.queries.some((query) => /on conflict\s*\(scope, key\)\s*do nothing/i.test(query)),
    ).toBe(true);

    await backend.close();
  });

  it("does not overwrite a claimed value when a later request retries", async () => {
    const pool = new ConcurrentPool();
    const backend = new PostgresKVBackend(
      postgresConfig(),
      pool as unknown as pg.Pool,
    );

    await expect(
      backend.claim("mem:request-ledger", "request-2", { fingerprint: "first" }),
    ).resolves.toEqual({
      claimed: true,
      value: { fingerprint: "first" },
    });
    await expect(
      backend.claim("mem:request-ledger", "request-2", { fingerprint: "retry" }),
    ).resolves.toEqual({
      claimed: false,
      value: { fingerprint: "first" },
    });
    await expect(backend.get("mem:request-ledger", "request-2")).resolves.toEqual({
      fingerprint: "first",
    });

    await backend.close();
  });

  it("keeps the original structured-write resource in a durable request ledger", async () => {
    const pool = new ConcurrentPool();
    const backend = new PostgresKVBackend(
      postgresConfig(),
      pool as unknown as pg.Pool,
    );

    const key = "mem::evidence-write:project:agent:request-1";
    const first = await backend.claim("mem:request-ledger", key, {
      id: key,
      resourceId: "evd_original",
      status: "claimed",
    });
    const retry = await backend.claim("mem:request-ledger", key, {
      id: key,
      resourceId: "evd_retry",
      status: "claimed",
    });

    expect(first.claimed).toBe(true);
    expect(retry).toEqual({
      claimed: false,
      value: { id: key, resourceId: "evd_original", status: "claimed" },
    });
    await backend.close();
  });
});

describe("StateKV atomic claim API", () => {
  it("delegates claims without changing existing backend requirements", async () => {
    const claim = vi.fn().mockResolvedValue({
      claimed: true,
      value: { requestId: "r1" },
    });
    const backend = {
      name: "test",
      handles: () => true,
      claim,
    } as unknown as StateKVBackend;
    const kv = new StateKV({} as ISdk, [backend]);

    await expect(kv.claim("mem:request-ledger", "r1", { requestId: "r1" })).resolves.toEqual({
      claimed: true,
      value: { requestId: "r1" },
    });
    expect(claim).toHaveBeenCalledWith("mem:request-ledger", "r1", {
      requestId: "r1",
    });
  });

  it("does not emulate an atomic claim when the selected backend lacks one", async () => {
    const backend = {
      name: "legacy",
      handles: () => true,
    } as unknown as StateKVBackend;
    const kv = new StateKV({} as ISdk, [backend]);

    await expect(kv.claim("mem:request-ledger", "r1", {})).rejects.toThrow(
      "Atomic KV claims are unavailable",
    );
  });
});
