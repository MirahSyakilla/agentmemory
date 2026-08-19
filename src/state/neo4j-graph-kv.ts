import neo4j, { type Driver } from "neo4j-driver";
import type { Neo4jConfig } from "../config.js";
import type { GraphEdge, GraphNode } from "../types.js";
import { logger } from "../logger.js";
import {
  applyJsonUpdate,
  type StateKVBackend,
  type StateKVGraphNeighborhood,
  type StateKVGraphNodePage,
  type StateKVGraphObservationIndexEntry,
  type StateKVGraphQueryOptions,
} from "./backend-kv.js";
import { KV } from "./schema.js";

const GRAPH_SCOPES = new Set<string>([
  KV.graphNodes,
  KV.graphEdges,
  KV.graphNameIndex,
  KV.graphEdgeKey,
  KV.graphNodeDegree,
  KV.graphObservationIndex,
  KV.graphObservationIndexBackfill,
]);

const GRAPH_OBSERVATION_INDEX_MERGE_MAX_ENTRIES = 1_000;
const GRAPH_OBSERVATION_INDEX_MERGE_MAX_NODE_IDS = 5_000;

function parseValue<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  return JSON.parse(value) as T;
}

function stringList(value: unknown): string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value;
}

function parseStringList(value: unknown): string[] | null {
  const direct = stringList(value);
  if (direct) return direct;
  try {
    return stringList(parseValue<unknown>(value));
  } catch {
    return null;
  }
}

function escapeFullTextQuery(value: string): string {
  return value.replace(/[+\-=&|><!(){}[\]^"~*?:\\/]/g, "\\$&");
}

function neo4jLimit(value: number): ReturnType<typeof neo4j.int> {
  return neo4j.int(Math.max(1, Math.floor(value)));
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const error = new Error("Neo4j graph query aborted");
  error.name = "AbortError";
  return error;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError(signal);
}

function awaitUntilAborted<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener("abort", onAbort);
      callback();
    };
    const onAbort = () => finish(() => reject(abortError(signal)));

    work.then(
      (value) => finish(() => resolve(value)),
      (error) => finish(() => reject(error)),
    );
    if (signal.aborted) {
      onAbort();
      return;
    }
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

export class Neo4jGraphKVBackend implements StateKVBackend {
  readonly name = "neo4j";
  private driver: Driver;
  private ready: Promise<void> | null = null;

  constructor(private config: Neo4jConfig) {
    const auth =
      config.user && config.password
        ? neo4j.auth.basic(config.user, config.password)
        : neo4j.auth.none();
    this.driver = neo4j.driver(config.url, auth);
  }

  handles(scope: string): boolean {
    return GRAPH_SCOPES.has(scope);
  }

  async ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.createConstraints();
    await this.ready;
  }

  async get<T = unknown>(scope: string, key: string): Promise<T | null> {
    await this.ensureReady();
    const session = this.session();
    try {
      if (scope === KV.graphNodes) {
        const res = await session.run(
          "match (n:AgentMemoryGraphNode {id: $key}) return n.value as value limit 1",
          { key },
        );
        return parseValue<T>(res.records[0]?.get("value"));
      }
      if (scope === KV.graphEdges) {
        const res = await session.run(
          "match ()-[r:AGENTMEMORY_GRAPH_EDGE {id: $key}]->() return r.value as value limit 1",
          { key },
        );
        return parseValue<T>(res.records[0]?.get("value"));
      }
      if (scope === KV.graphObservationIndex) {
        const res = await session.run(
          `match (n:AgentMemoryGraphKV {scope: $scope, key: $key})
           return n.nodeIds as nodeIds, n.value as value limit 1`,
          { scope, key },
        );
        const record = res.records[0];
        const nodeIds = parseStringList(record?.get("nodeIds"));
        return nodeIds ? (nodeIds as T) : parseValue<T>(record?.get("value"));
      }
      const res = await session.run(
        `match (n:AgentMemoryGraphKV {scope: $scope, key: $key})
         return n.value as value limit 1`,
        { scope, key },
      );
      return parseValue<T>(res.records[0]?.get("value"));
    } finally {
      await session.close();
    }
  }

  async set<T = unknown>(scope: string, key: string, value: T): Promise<T> {
    await this.ensureReady();
    const session = this.session();
    try {
      if (scope === KV.graphNodes) {
        await this.setGraphNode(session, key, value as GraphNode);
      } else if (scope === KV.graphEdges) {
        await this.setGraphEdge(session, key, value as GraphEdge);
      } else if (scope === KV.graphObservationIndex && stringList(value)) {
        const nodeIds = stringList(value)!;
        await session.run(
          `merge (n:AgentMemoryGraphKV {scope: $scope, key: $key})
           set n.value = $value,
               n.nodeIds = $nodeIds,
               n.updatedAt = datetime()`,
          { scope, key, value: JSON.stringify(nodeIds), nodeIds },
        );
      } else {
        await session.run(
          `merge (n:AgentMemoryGraphKV {scope: $scope, key: $key})
           set n.value = $value, n.updatedAt = datetime()`,
          { scope, key, value: JSON.stringify(value) },
        );
      }
      return value;
    } finally {
      await session.close();
    }
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
    const session = this.session();
    try {
      if (scope === KV.graphNodes) {
        await session.run(
          "match (n:AgentMemoryGraphNode {id: $key}) detach delete n",
          { key },
        );
      } else if (scope === KV.graphEdges) {
        await session.run(
          "match ()-[r:AGENTMEMORY_GRAPH_EDGE {id: $key}]->() delete r",
          { key },
        );
      } else {
        await session.run(
          "match (n:AgentMemoryGraphKV {scope: $scope, key: $key}) delete n",
          { scope, key },
        );
      }
    } finally {
      await session.close();
    }
  }

  async list<T = unknown>(scope: string): Promise<T[]> {
    return this.listInternal<T>(scope);
  }

  async listWithTimeout<T = unknown>(
    scope: string,
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<T[]> {
    const controller = new AbortController();
    const boundedTimeoutMs = Math.max(1, Math.floor(timeoutMs));
    const onAbort = () => controller.abort(signal?.reason);
    const timer = setTimeout(() => {
      const error = new Error(
        `Neo4j graph query timed out after ${boundedTimeoutMs}ms`,
      );
      error.name = "TimeoutError";
      controller.abort(error);
    }, boundedTimeoutMs);

    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });

    const work = this.listInternal<T>(scope, boundedTimeoutMs, controller.signal);
    try {
      return await awaitUntilAborted(work, controller.signal);
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  private async listInternal<T = unknown>(
    scope: string,
    timeoutMs?: number,
    signal?: AbortSignal,
  ): Promise<T[]> {
    throwIfAborted(signal);
    await this.ensureReady();
    throwIfAborted(signal);
    const session = this.session();
    let sessionClosed = false;
    const closeSession = () => {
      if (sessionClosed) return;
      sessionClosed = true;
      // Closing a Neo4j session cancels pending result streams. Do not await
      // here: the caller's wall-clock deadline must win over cleanup latency.
      void session.close().catch(() => {});
    };
    signal?.addEventListener("abort", closeSession, { once: true });
    const transactionConfig = timeoutMs ? { timeout: timeoutMs } : undefined;
    try {
      if (scope === KV.graphNodes) {
        const res = await session.run(
          "match (n:AgentMemoryGraphNode) return n.value as value order by n.updatedAt",
          undefined,
          transactionConfig,
        );
        throwIfAborted(signal);
        return res.records
          .map((record) => parseValue<T>(record.get("value")))
          .filter((value): value is T => value !== null);
      }
      if (scope === KV.graphEdges) {
        const res = await session.run(
          "match ()-[r:AGENTMEMORY_GRAPH_EDGE]->() return r.value as value order by r.updatedAt",
          undefined,
          transactionConfig,
        );
        throwIfAborted(signal);
        return res.records
          .map((record) => parseValue<T>(record.get("value")))
          .filter((value): value is T => value !== null);
      }
      if (scope === KV.graphObservationIndex) {
        const res = await session.run(
          `match (n:AgentMemoryGraphKV {scope: $scope})
           return n.nodeIds as nodeIds, n.value as value order by n.updatedAt`,
          { scope },
          transactionConfig,
        );
        throwIfAborted(signal);
        return res.records
          .map((record) => {
            const nodeIds = parseStringList(record.get("nodeIds"));
            return nodeIds ? (nodeIds as T) : parseValue<T>(record.get("value"));
          })
          .filter((value): value is T => value !== null);
      }
      const res = await session.run(
        `match (n:AgentMemoryGraphKV {scope: $scope})
         return n.value as value order by n.updatedAt`,
        { scope },
        transactionConfig,
      );
      throwIfAborted(signal);
      return res.records
        .map((record) => parseValue<T>(record.get("value")))
        .filter((value): value is T => value !== null);
    } finally {
      signal?.removeEventListener("abort", closeSession);
      if (!sessionClosed) await session.close();
    }
  }

  async findGraphNodesByNames(
    names: string[],
    limit: number,
    options: StateKVGraphQueryOptions = {},
  ): Promise<GraphNode[]> {
    const searchNames = [
      ...new Set(
        names
          .map((name) => name.trim().normalize("NFKC").toLowerCase())
          .filter(Boolean),
      ),
    ];
    if (searchNames.length === 0) return [];
    return this.withGraphSession(options, async (session, transactionConfig) => {
      const safeQuery = searchNames
        .map((name) => `${escapeFullTextQuery(name)}*`)
        .join(" OR ");
      const res = await session.run(
        `call db.index.fulltext.queryNodes(
           $indexName, $query
         ) yield node, score
         where coalesce(node.stale, false) = false
         return node.value as value order by score desc limit $limit`,
        {
          indexName: "agentmemory_graph_node_name_fulltext",
          query: safeQuery,
          limit: neo4jLimit(Math.min(100, limit)),
        },
        transactionConfig,
      );
      return res.records
        .map((record) => parseValue<GraphNode>(record.get("value")))
        .filter((value): value is GraphNode => value !== null);
    });
  }

  async findGraphNodesByObservationIds(
    observationIds: string[],
    limit: number,
    options: StateKVGraphQueryOptions = {},
  ): Promise<GraphNode[]> {
    const ids = [...new Set(observationIds.filter(Boolean))];
    if (ids.length === 0) return [];
    return this.withGraphSession(options, async (session, transactionConfig) => {
      const indexResult = await session.run(
        `match (i:AgentMemoryGraphKV {scope: $scope})
         where i.key in $observationIds
         return i.nodeIds as nodeIds, i.value as value`,
        { scope: KV.graphObservationIndex, observationIds: ids },
        transactionConfig,
      );
      const nodeIds = [
        ...new Set(
          indexResult.records.flatMap((record) => {
            return (
              parseStringList(record.get("nodeIds")) ??
              parseStringList(record.get("value")) ??
              []
            );
          }),
        ),
      ];
      if (nodeIds.length === 0) return [];

      const nodesResult = await session.run(
        `match (n:AgentMemoryGraphNode)
         where n.id in $nodeIds and coalesce(n.stale, false) = false
         return n.value as value order by n.updatedAt desc limit $limit`,
        {
          nodeIds,
          limit: neo4jLimit(Math.min(100, limit)),
        },
        transactionConfig,
      );
      return nodesResult.records
        .map((record) => parseValue<GraphNode>(record.get("value")))
        .filter((value): value is GraphNode => value !== null);
    });
  }

  async getGraphNeighborhood(
    nodeIds: string[],
    maxDepth: number,
    maxNodes: number,
    options: StateKVGraphQueryOptions = {},
  ): Promise<StateKVGraphNeighborhood> {
    const starts = [...new Set(nodeIds.filter(Boolean))];
    if (starts.length === 0) return { nodes: [], edges: [] };
    const depth = Math.max(0, Math.min(3, Math.floor(maxDepth)));
    const nodeLimit = Math.max(1, Math.min(500, Math.floor(maxNodes)));

    return this.withGraphSession(options, async (session, transactionConfig) => {
      const nodeResult = await session.run(
        `match (n:AgentMemoryGraphNode)
         where n.id in $nodeIds and coalesce(n.stale, false) = false
         return n.value as value limit $limit`,
        { nodeIds: starts, limit: neo4jLimit(nodeLimit) },
        transactionConfig,
      );
      const nodes = nodeResult.records
        .map((record) => parseValue<GraphNode>(record.get("value")))
        .filter((value): value is GraphNode => value !== null);
      if (nodes.length === 0 || depth === 0) return { nodes, edges: [] };

      const nodeById = new Map(nodes.map((node) => [node.id, node]));
      const edgesById = new Map<string, GraphEdge>();
      let frontierIds = nodes.map((node) => node.id);
      const edgeLimit = Math.min(2000, Math.max(10, nodeLimit * 8));

      for (let level = 0; level < depth && frontierIds.length > 0; level++) {
        const edgeResult = await session.run(
          `match (source:AgentMemoryGraphNode)-[r:AGENTMEMORY_GRAPH_EDGE]-(target:AgentMemoryGraphNode)
           where source.id in $frontierIds
             and coalesce(source.stale, false) = false
             and coalesce(target.stale, false) = false
             and coalesce(r.stale, false) = false
           with target, r order by coalesce(r.weight, 0) desc limit $limit
           return target.value as targetValue, r.value as edgeValue
          `,
          {
            frontierIds,
            limit: neo4jLimit(edgeLimit),
          },
          transactionConfig,
        );
        const nextFrontier: string[] = [];
        for (const record of edgeResult.records) {
          const edge = parseValue<GraphEdge>(record.get("edgeValue"));
          const target = parseValue<GraphNode>(record.get("targetValue"));
          if (edge) edgesById.set(edge.id, edge);
          if (target && !nodeById.has(target.id) && nodeById.size < nodeLimit) {
            nodeById.set(target.id, target);
            nextFrontier.push(target.id);
          }
        }
        frontierIds = nextFrontier;
      }

      const neighborhoodIds = [...nodeById.keys()];
      const edges = [...edgesById.values()].filter(
        (edge) =>
          neighborhoodIds.includes(edge.sourceNodeId) &&
          neighborhoodIds.includes(edge.targetNodeId),
      );
      return { nodes: [...nodeById.values()], edges };
    });
  }

  async pageGraphNodes(
    afterId: string,
    limit: number,
    options: StateKVGraphQueryOptions = {},
  ): Promise<StateKVGraphNodePage> {
    const boundedLimit = Math.max(1, Math.min(100, Math.floor(limit)));
    return this.withGraphSession(options, async (session, transactionConfig) => {
      const result = await session.run(
        `match (n:AgentMemoryGraphNode)
         where n.id > $afterId and coalesce(n.stale, false) = false
         return n.id as id, n.value as value
         order by id asc
         limit $limit`,
        {
          afterId,
          limit: neo4jLimit(boundedLimit + 1),
        },
        transactionConfig,
      );
      const records = result.records.slice(0, boundedLimit);
      const lastRecord = records[records.length - 1];
      return {
        nodes: records
          .map((record) => {
            const node = parseValue<GraphNode>(record.get("value"));
            const id = record.get("id");
            return node && typeof id === "string" ? { ...node, id } : null;
          })
          .filter((node): node is GraphNode => node !== null),
        nextCursor:
          typeof lastRecord?.get("id") === "string"
            ? lastRecord.get("id")
            : null,
        hasMore: result.records.length > boundedLimit,
      };
    });
  }

  async mergeGraphObservationIndex(
    entries: StateKVGraphObservationIndexEntry[],
    options: StateKVGraphQueryOptions = {},
  ): Promise<void> {
    const normalized = entries
      .map((entry) => ({
        observationId: entry.observationId.trim(),
        nodeIds: [...new Set(entry.nodeIds.filter(Boolean))],
      }))
      .filter((entry) => entry.observationId && entry.nodeIds.length > 0);
    if (normalized.length === 0) return;

    const batches: StateKVGraphObservationIndexEntry[][] = [];
    let batch: StateKVGraphObservationIndexEntry[] = [];
    let nodeIdCount = 0;
    for (const entry of normalized) {
      if (
        batch.length > 0 &&
        (batch.length >= GRAPH_OBSERVATION_INDEX_MERGE_MAX_ENTRIES ||
          nodeIdCount + entry.nodeIds.length >
            GRAPH_OBSERVATION_INDEX_MERGE_MAX_NODE_IDS)
      ) {
        batches.push(batch);
        batch = [];
        nodeIdCount = 0;
      }
      batch.push(entry);
      nodeIdCount += entry.nodeIds.length;
    }
    if (batch.length > 0) batches.push(batch);

    await this.withGraphSession(options, async (session, transactionConfig) => {
      for (const batchEntries of batches) {
        await session.run(
          `unwind $entries as entry
           merge (i:AgentMemoryGraphKV {
             scope: $scope,
             key: entry.observationId
           })
           on create set i.value = $emptyValue, i.nodeIds = []
           with i, entry, coalesce(i.nodeIds, []) as existingNodeIds
           with i, existingNodeIds,
             [nodeId in entry.nodeIds where not nodeId in existingNodeIds] as additions
           set i.nodeIds = existingNodeIds + additions,
               i.updatedAt = datetime()`,
          {
            scope: KV.graphObservationIndex,
            entries: batchEntries,
            emptyValue: JSON.stringify([]),
          },
          transactionConfig,
        );
      }
    });
  }

  private async withGraphSession<T>(
    options: StateKVGraphQueryOptions,
    work: (
      session: ReturnType<Driver["session"]>,
      transactionConfig: { timeout: number } | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    const controller = new AbortController();
    const timeoutMs =
      typeof options.timeoutMs === "number"
        ? Math.max(1, Math.floor(options.timeoutMs))
        : undefined;
    const onAbort = () => controller.abort(options.signal?.reason);
    const timer = timeoutMs
      ? setTimeout(() => {
          const error = new Error(
            `Neo4j graph query timed out after ${timeoutMs}ms`,
          );
          error.name = "TimeoutError";
          controller.abort(error);
        }, timeoutMs)
      : undefined;
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    const workPromise = this.withGraphSessionInternal(
      controller.signal,
      timeoutMs,
      work,
    );
    try {
      return await awaitUntilAborted(workPromise, controller.signal);
    } finally {
      if (timer) clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
    }
  }

  private async withGraphSessionInternal<T>(
    signal: AbortSignal,
    timeoutMs: number | undefined,
    work: (
      session: ReturnType<Driver["session"]>,
      transactionConfig: { timeout: number } | undefined,
    ) => Promise<T>,
  ): Promise<T> {
    throwIfAborted(signal);
    await this.ensureReady();
    throwIfAborted(signal);
    const session = this.session();
    let sessionClosed = false;
    const closeSession = () => {
      if (sessionClosed) return;
      sessionClosed = true;
      void session.close().catch(() => {});
    };
    signal.addEventListener("abort", closeSession, { once: true });
    try {
      return await work(
        session,
        timeoutMs ? { timeout: timeoutMs } : undefined,
      );
    } finally {
      signal.removeEventListener("abort", closeSession);
      if (!sessionClosed) await session.close();
    }
  }

  async close(): Promise<void> {
    await this.driver.close();
  }

  private session() {
    return this.config.database
      ? this.driver.session({ database: this.config.database })
      : this.driver.session();
  }

  private async createConstraints(): Promise<void> {
    await this.driver.verifyConnectivity();
    const session = this.session();
    try {
      await session.run(
        "create constraint agentmemory_graph_node_id if not exists for (n:AgentMemoryGraphNode) require n.id is unique",
      );
      for (const statement of [
        "create index agentmemory_graph_kv_scope_key if not exists for (n:AgentMemoryGraphKV) on (n.scope, n.key)",
        "create index agentmemory_graph_node_name_normalized if not exists for (n:AgentMemoryGraphNode) on (n.nameNormalized)",
        "create fulltext index agentmemory_graph_node_name_fulltext if not exists for (n:AgentMemoryGraphNode) on each [n.name]",
      ]) {
        try {
          await session.run(statement);
        } catch (error) {
          logger.warn("Neo4j graph search index creation failed", {
            statement,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    } finally {
      await session.close();
    }
  }

  private async setGraphNode(
    session: ReturnType<Driver["session"]>,
    key: string,
    value: GraphNode,
  ): Promise<void> {
    await session.run(
      `merge (n:AgentMemoryGraphNode {id: $key})
       set n.value = $value,
            n.type = $type,
            n.name = $name,
            n.nameNormalized = $nameNormalized,
            n.sourceObservationIds = $sourceObservationIds,
            n.sourceSessionIds = $sourceSessionIds,
            n.stale = $stale,
           n.updatedAt = datetime()`,
      {
        key,
        value: JSON.stringify(value),
        type: value.type,
        name: value.name,
        nameNormalized: value.name.normalize("NFKC").toLowerCase(),
        sourceObservationIds: value.sourceObservationIds,
        sourceSessionIds: value.sourceSessionIds ?? [],
        stale: value.stale === true,
      },
    );
  }

  private async setGraphEdge(
    session: ReturnType<Driver["session"]>,
    key: string,
    value: GraphEdge,
  ): Promise<void> {
    await session.run(
      `merge (s:AgentMemoryGraphNode {id: $sourceNodeId})
       on create set s.value = $emptyNode, s.name = $sourceNodeId, s.type = "unknown", s.stale = true, s.updatedAt = datetime()
       merge (t:AgentMemoryGraphNode {id: $targetNodeId})
       on create set t.value = $emptyTargetNode, t.name = $targetNodeId, t.type = "unknown", t.stale = true, t.updatedAt = datetime()
       merge (s)-[r:AGENTMEMORY_GRAPH_EDGE {id: $key}]->(t)
       set r.value = $value,
           r.edgeType = $edgeType,
           r.weight = $weight,
           r.stale = $stale,
           r.updatedAt = datetime()`,
      {
        key,
        sourceNodeId: value.sourceNodeId,
        targetNodeId: value.targetNodeId,
        edgeType: value.type,
        weight: value.weight,
        stale: value.stale === true,
        value: JSON.stringify(value),
        emptyNode: JSON.stringify({
          id: value.sourceNodeId,
          type: "concept",
          name: value.sourceNodeId,
          properties: {},
          sourceObservationIds: [],
          createdAt: new Date().toISOString(),
          stale: true,
        } satisfies GraphNode),
        emptyTargetNode: JSON.stringify({
          id: value.targetNodeId,
          type: "concept",
          name: value.targetNodeId,
          properties: {},
          sourceObservationIds: [],
          createdAt: new Date().toISOString(),
          stale: true,
        } satisfies GraphNode),
      },
    );
  }
}
