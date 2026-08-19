import type { GraphEdge, GraphNode } from "../types.js";

export type StateKVJsonPrimitive = string | number | boolean | null;

export type StateKVJsonFilter =
  | { field: string; operator: "exists" }
  | {
      field: string;
      operator: "equals" | "not_equals" | "equals_or_missing";
      value: StateKVJsonPrimitive;
    };

export interface StateKVJsonAggregateRequest {
  scopes: string[];
  filters?: StateKVJsonFilter[];
  collectStringFields?: string[];
}

export interface StateKVJsonAggregateResult {
  count: number;
  serializedChars: number;
  stringValues: Record<string, string[]>;
}

export interface StateKVGraphQueryOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
}

export interface StateKVGraphNeighborhood {
  nodes: GraphNode[];
  edges: GraphEdge[];
}

export interface StateKVGraphNodePage {
  nodes: GraphNode[];
  nextCursor: string | null;
  hasMore: boolean;
}

export interface StateKVGraphObservationIndexEntry {
  observationId: string;
  nodeIds: string[];
}

export interface StateKVClaimResult<T = unknown> {
  claimed: boolean;
  value: T | null;
}

export interface StateKVBackend {
  readonly name: string;
  handles(scope: string): boolean;
  get<T = unknown>(scope: string, key: string): Promise<T | null>;
  set<T = unknown>(scope: string, key: string, value: T): Promise<T>;
  claim?<T = unknown>(
    scope: string,
    key: string,
    value: T,
  ): Promise<StateKVClaimResult<T>>;
  update<T = unknown>(
    scope: string,
    key: string,
    ops: Array<{ type: string; path: string; value?: unknown }>,
  ): Promise<T>;
  delete(scope: string, key: string): Promise<void>;
  list<T = unknown>(scope: string): Promise<T[]>;
  /** Optional bounded list used by latency-sensitive graph retrieval. */
  listWithTimeout?<T = unknown>(
    scope: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T[]>;
  findGraphNodesByNames?(
    names: string[],
    limit: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<GraphNode[]>;
  findGraphNodesByObservationIds?(
    observationIds: string[],
    limit: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<GraphNode[]>;
  getGraphNeighborhood?(
    nodeIds: string[],
    maxDepth: number,
    maxNodes: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<StateKVGraphNeighborhood>;
  pageGraphNodes?(
    afterId: string,
    limit: number,
    options?: StateKVGraphQueryOptions,
  ): Promise<StateKVGraphNodePage>;
  mergeGraphObservationIndex?(
    entries: StateKVGraphObservationIndexEntry[],
    options?: StateKVGraphQueryOptions,
  ): Promise<void>;
  aggregateJson?(
    request: StateKVJsonAggregateRequest,
  ): Promise<StateKVJsonAggregateResult>;
}

export function applyJsonUpdate<T>(
  current: T | null,
  ops: Array<{ type: string; path: string; value?: unknown }>,
): T {
  const root: unknown =
    current && typeof current === "object"
      ? Array.isArray(current)
        ? [...current]
        : { ...(current as Record<string, unknown>) }
      : {};
  for (const op of ops) {
    if (op.type !== "set") continue;
    const parts = op.path
      .replace(/^\//, "")
      .split(/[/.]/)
      .map((p) => p.trim())
      .filter(Boolean);
    if (parts.length === 0) continue;
    let cursor = root as Record<string, unknown>;
    for (const part of parts.slice(0, -1)) {
      const next = cursor[part];
      if (!next || typeof next !== "object" || Array.isArray(next)) {
        cursor[part] = {};
      }
      cursor = cursor[part] as Record<string, unknown>;
    }
    cursor[parts[parts.length - 1]] = op.value;
  }
  return root as T;
}
