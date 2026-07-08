import neo4j, { type Driver } from "neo4j-driver";
import type { Neo4jConfig } from "../config.js";
import type { GraphEdge, GraphNode } from "../types.js";
import { applyJsonUpdate, type StateKVBackend } from "./backend-kv.js";
import { KV } from "./schema.js";

const GRAPH_SCOPES = new Set<string>([
  KV.graphNodes,
  KV.graphEdges,
  KV.graphNameIndex,
  KV.graphEdgeKey,
  KV.graphNodeDegree,
]);

function parseValue<T>(value: unknown): T | null {
  if (typeof value !== "string") return null;
  return JSON.parse(value) as T;
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
    await this.ensureReady();
    const session = this.session();
    try {
      if (scope === KV.graphNodes) {
        const res = await session.run(
          "match (n:AgentMemoryGraphNode) return n.value as value order by n.updatedAt",
        );
        return res.records
          .map((record) => parseValue<T>(record.get("value")))
          .filter((value): value is T => value !== null);
      }
      if (scope === KV.graphEdges) {
        const res = await session.run(
          "match ()-[r:AGENTMEMORY_GRAPH_EDGE]->() return r.value as value order by r.updatedAt",
        );
        return res.records
          .map((record) => parseValue<T>(record.get("value")))
          .filter((value): value is T => value !== null);
      }
      const res = await session.run(
        `match (n:AgentMemoryGraphKV {scope: $scope})
         return n.value as value order by n.updatedAt`,
        { scope },
      );
      return res.records
        .map((record) => parseValue<T>(record.get("value")))
        .filter((value): value is T => value !== null);
    } finally {
      await session.close();
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
           n.stale = $stale,
           n.updatedAt = datetime()`,
      {
        key,
        value: JSON.stringify(value),
        type: value.type,
        name: value.name,
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
