import pg from "pg";
import type { PostgresConfig } from "../config.js";
import { KV } from "./schema.js";
import {
  applyJsonUpdate,
  type StateKVBackend,
  type StateKVClaimResult,
  type StateKVJsonAggregateRequest,
  type StateKVJsonAggregateResult,
} from "./backend-kv.js";

const GRAPH_SCOPES = new Set<string>([
  KV.graphNodes,
  KV.graphEdges,
  KV.graphNameIndex,
  KV.graphEdgeKey,
  KV.graphNodeDegree,
  KV.graphObservationIndex,
  KV.graphObservationIndexBackfill,
]);

function clientConfig(config: PostgresConfig): pg.ClientConfig {
  return {
    ...(config.connectionString
      ? { connectionString: config.connectionString }
      : {
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password: config.password,
        }),
    connectionTimeoutMillis: 3000,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  };
}

export class PostgresKVBackend implements StateKVBackend {
  readonly name = "postgres";
  private pool: pg.Pool;
  private ready: Promise<void> | null = null;

  constructor(config: PostgresConfig, pool?: pg.Pool) {
    this.pool =
      pool ??
      new pg.Pool({
        ...clientConfig(config),
        max: 10,
        idleTimeoutMillis: 30_000,
      });
  }

  handles(scope: string): boolean {
    return !GRAPH_SCOPES.has(scope);
  }

  async ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.createSchema();
    await this.ready;
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    await this.ensureReady();
    const res = await this.pool.query(
      "select value from agentmemory_kv where scope = $1 and key = $2",
      [scope, key],
    );
    return (res.rows[0]?.value as T | undefined) ?? null;
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    await this.ensureReady();
    await this.pool.query(
      `insert into agentmemory_kv(scope, key, value, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict(scope, key) do update
       set value = excluded.value, updated_at = now()`,
      [scope, key, JSON.stringify(value)],
    );
    return value;
  }

  async claim<T = unknown>(
    scope: string,
    key: string,
    value: T,
  ): Promise<StateKVClaimResult<T>> {
    await this.ensureReady();
    const inserted = await this.pool.query(
      `insert into agentmemory_kv(scope, key, value, updated_at)
       values ($1, $2, $3::jsonb, now())
       on conflict(scope, key) do nothing
       returning value`,
      [scope, key, JSON.stringify(value)],
    );
    if (inserted.rows.length > 0) {
      return { claimed: true, value: inserted.rows[0].value as T };
    }

    const existing = await this.pool.query(
      "select value from agentmemory_kv where scope = $1 and key = $2",
      [scope, key],
    );
    return {
      claimed: false,
      value: (existing.rows[0]?.value as T | undefined) ?? null,
    };
  }

  async update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T> {
    const current = await this.get<T>(scope, key);
    const next = applyJsonUpdate(current, ops);
    await this.set(scope, key, next);
    return next;
  }

  async delete(scope: string, key: string): Promise<void> {
    await this.ensureReady();
    await this.pool.query(
      "delete from agentmemory_kv where scope = $1 and key = $2",
      [scope, key],
    );
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    await this.ensureReady();
    const res = await this.pool.query(
      "select value from agentmemory_kv where scope = $1 order by updated_at asc",
      [scope],
    );
    return res.rows.map((row) => row.value as T);
  }

  async aggregateJson(
    request: StateKVJsonAggregateRequest,
  ): Promise<StateKVJsonAggregateResult> {
    if (request.scopes.length === 0) {
      return {
        count: 0,
        serializedChars: 0,
        stringValues: Object.fromEntries(
          (request.collectStringFields ?? []).map((field) => [field, []]),
        ),
      };
    }
    await this.ensureReady();
    const params: unknown[] = [request.scopes];
    const predicates = ["scope = any($1::text[])"];
    for (const filter of request.filters ?? []) {
      params.push(filter.field);
      const fieldParam = `$${params.length}`;
      if (filter.operator === "exists") {
        predicates.push(`value ? ${fieldParam}`);
        continue;
      }
      params.push(JSON.stringify(filter.value));
      const valueParam = `$${params.length}::jsonb`;
      if (filter.operator === "equals") {
        predicates.push(`value -> ${fieldParam} = ${valueParam}`);
      } else if (filter.operator === "not_equals") {
        predicates.push(`value -> ${fieldParam} is distinct from ${valueParam}`);
      } else {
        predicates.push(
          `(not (value ? ${fieldParam}) or value -> ${fieldParam} = ${valueParam})`,
        );
      }
    }

    const stringSelections: string[] = [];
    for (const [index, field] of (request.collectStringFields ?? []).entries()) {
      params.push(field);
      const fieldParam = `$${params.length}`;
      stringSelections.push(
        `coalesce(array_agg(distinct value ->> ${fieldParam}) filter (` +
          `where jsonb_typeof(value -> ${fieldParam}) = 'string' and ` +
          `value ->> ${fieldParam} <> ''), array[]::text[]) as strings_${index}`,
      );
    }

    const res = await this.pool.query(
      `select count(*)::text as count,
              coalesce(sum(length(value::text)), 0)::text as serialized_chars
              ${stringSelections.length > 0 ? `, ${stringSelections.join(", ")}` : ""}
       from agentmemory_kv
       where ${predicates.join(" and ")}`,
      params,
    );
    const row = res.rows[0] ?? {};
    return {
      count: Number(row.count) || 0,
      serializedChars: Number(row.serialized_chars) || 0,
      stringValues: Object.fromEntries(
        (request.collectStringFields ?? []).map((field, index) => [
          field,
          Array.isArray(row[`strings_${index}`]) ? row[`strings_${index}`] : [],
        ]),
      ),
    };
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  private async createSchema(): Promise<void> {
    await this.pool.query(`
      create table if not exists agentmemory_kv (
        scope text not null,
        key text not null,
        value jsonb not null,
        updated_at timestamptz not null default now(),
        primary key (scope, key)
      )
    `);
    await this.pool.query(
      "create index if not exists agentmemory_kv_scope_updated_idx on agentmemory_kv(scope, updated_at)",
    );
  }
}
