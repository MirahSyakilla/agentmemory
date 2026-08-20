import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HybridSearch } from "../src/state/hybrid-search.js";
import { SearchIndex } from "../src/state/search-index.js";
import { VectorIndex } from "../src/state/vector-index.js";
import { logger } from "../src/logger.js";
import type {
  CompressedObservation,
  EmbeddingProvider,
  GraphEdge,
  GraphNode,
} from "../src/types.js";

function makeObs(
  overrides: Partial<CompressedObservation> = {},
): CompressedObservation {
  return {
    id: "obs_1",
    sessionId: "ses_1",
    timestamp: new Date().toISOString(),
    type: "file_edit",
    title: "Edit auth middleware",
    subtitle: "JWT validation",
    facts: ["Added token check"],
    narrative: "Modified the auth middleware to validate JWT tokens",
    concepts: ["authentication", "jwt"],
    files: ["src/middleware/auth.ts"],
    importance: 7,
    ...overrides,
  };
}

function mockKV() {
  const store = new Map<string, Map<string, unknown>>();
  const list = async <T>(scope: string): Promise<T[]> => {
    const entries = store.get(scope);
    return entries ? (Array.from(entries.values()) as T[]) : [];
  };
  const getGraphNeighborhood = async (nodeIds: string[], maxDepth: number) => {
    const nodes = await list<GraphNode>("mem:graph:nodes");
    const edges = await list<GraphEdge>("mem:graph:edges");
    const nodeById = new Map(nodes.map((node) => [node.id, node]));
    const included = new Set(nodeIds);
    let frontier = nodeIds;
    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Set<string>();
      for (const edge of edges) {
        if (frontier.includes(edge.sourceNodeId)) next.add(edge.targetNodeId);
        if (frontier.includes(edge.targetNodeId)) next.add(edge.sourceNodeId);
      }
      for (const id of next) included.add(id);
      frontier = [...next];
    }
    return {
      nodes: [...included]
        .map((id) => nodeById.get(id))
        .filter((node): node is GraphNode => Boolean(node)),
      edges: edges.filter(
        (edge) =>
          included.has(edge.sourceNodeId) && included.has(edge.targetNodeId),
      ),
    };
  };

  return {
    get: async <T>(scope: string, key: string): Promise<T | null> => {
      return (store.get(scope)?.get(key) as T) ?? null;
    },
    set: async <T>(scope: string, key: string, data: T): Promise<T> => {
      if (!store.has(scope)) store.set(scope, new Map());
      store.get(scope)!.set(key, data);
      return data;
    },
    delete: async (scope: string, key: string): Promise<void> => {
      store.get(scope)?.delete(key);
    },
    list,
    findGraphNodesByNames: async (names: string[]) =>
      (await list<GraphNode>("mem:graph:nodes")).filter((node) =>
        names.some((name) =>
          node.name.toLowerCase().includes(name.toLowerCase()),
        ),
      ),
    findGraphNodesByObservationIds: async (obsIds: string[]) =>
      (await list<GraphNode>("mem:graph:nodes")).filter((node) =>
        (node.sourceObservationIds ?? []).some((obsId) =>
          obsIds.includes(obsId),
        ),
      ),
    getGraphNeighborhood,
  };
}

function delayedGraphKV(
  delayMs: number,
  mode: "resolve" | "reject" = "resolve",
) {
  const base = mockKV();
  const delay = async (signal?: AbortSignal): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(resolve, delayMs);
      const onAbort = () => {
        clearTimeout(timer);
        const error = new Error("graph backend aborted");
        error.name = "AbortError";
        reject(error);
      };
      if (signal?.aborted) {
        onAbort();
        return;
      }
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    if (mode === "reject") throw new Error("graph backend failed");
  };
  return {
    ...base,
    findGraphNodesByNames: async (
      names: string[],
      _limit: number,
      options?: { signal?: AbortSignal },
    ) => {
      await delay(options?.signal);
      return base.findGraphNodesByNames(names);
    },
    findGraphNodesByObservationIds: async (
      obsIds: string[],
      _limit: number,
      options?: { signal?: AbortSignal },
    ) => {
      await delay(options?.signal);
      return base.findGraphNodesByObservationIds(obsIds);
    },
    getGraphNeighborhood: async (
      nodeIds: string[],
      maxDepth: number,
      _maxNodes: number,
      options?: { signal?: AbortSignal },
    ) => {
      await delay(options?.signal);
      return base.getGraphNeighborhood(nodeIds, maxDepth);
    },
  };
}

describe("HybridSearch", () => {
  let bm25: SearchIndex;
  let kv: ReturnType<typeof mockKV>;
  const originalSmartSearchGraph = process.env["AGENTMEMORY_SMART_SEARCH_GRAPH"];

  beforeEach(() => {
    bm25 = new SearchIndex();
    kv = mockKV();
    process.env["AGENTMEMORY_SMART_SEARCH_GRAPH"] = "true";
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalSmartSearchGraph === undefined) {
      delete process.env["AGENTMEMORY_SMART_SEARCH_GRAPH"];
    } else {
      process.env["AGENTMEMORY_SMART_SEARCH_GRAPH"] = originalSmartSearchGraph;
    }
    delete process.env["AGENTMEMORY_GRAPH_SEARCH_TIMEOUT_MS"];
  });

  it("returns BM25-only results when no vector index is provided", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("obs_1");
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].bm25Score).toBeGreaterThan(0);
  });

  it("returns empty results for no-match query", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("database");
    expect(results).toEqual([]);
  });

  it("combinedScore is derived from bm25Score when no vector index", async () => {
    const obs = makeObs({ id: "obs_1", sessionId: "ses_1" });
    bm25.add(obs);
    await kv.set("mem:obs:ses_1", "obs_1", obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results[0].combinedScore).toBeGreaterThan(0);
    expect(results[0].vectorScore).toBe(0);
    expect(results[0].graphScore).toBe(0);
  });

  it("results are sorted by combinedScore descending", async () => {
    const obs1 = makeObs({
      id: "obs_1",
      sessionId: "ses_1",
      title: "auth handler",
      narrative: "auth auth auth module",
      concepts: ["auth"],
    });
    const obs2 = makeObs({
      id: "obs_2",
      sessionId: "ses_1",
      title: "database setup",
      narrative: "auth connection config",
      concepts: ["database"],
    });
    bm25.add(obs1);
    bm25.add(obs2);
    await kv.set("mem:obs:ses_1", "obs_1", obs1);
    await kv.set("mem:obs:ses_1", "obs_2", obs2);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");

    expect(results.length).toBe(2);
    expect(results[0].combinedScore).toBeGreaterThanOrEqual(
      results[1].combinedScore,
    );
  });

  it("respects limit parameter", async () => {
    for (let i = 0; i < 10; i++) {
      const obs = makeObs({
        id: `obs_${i}`,
        sessionId: "ses_1",
        title: `auth feature ${i}`,
      });
      bm25.add(obs);
      await kv.set("mem:obs:ses_1", `obs_${i}`, obs);
    }

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth", 3);
    expect(results.length).toBe(3);
  });

  it("caches repeated query embeddings and applies scope to both streams", async () => {
    const inScope = makeObs({
      id: "obs_scope",
      sessionId: "ses_scope",
      project: "my-project",
      agentId: "agent-a",
      title: "auth scoped result",
    });
    const other = makeObs({
      id: "obs_other",
      sessionId: "ses_other",
      project: "other-project",
      agentId: "agent-b",
      title: "auth other result",
    });
    bm25.add(inScope);
    bm25.add(other);
    await kv.set("mem:obs:ses_scope", inScope.id, inScope);
    await kv.set("mem:obs:ses_other", other.id, other);

    const vector = new VectorIndex();
    vector.add(inScope.id, inScope.sessionId, new Float32Array([1, 0]), {
      project: inScope.project,
      agentId: inScope.agentId,
    });
    vector.add(other.id, other.sessionId, new Float32Array([1, 0]), {
      project: other.project,
      agentId: other.agentId,
    });
    const provider: EmbeddingProvider = {
      name: "test-embedding",
      dimensions: 2,
      embed: vi.fn(async () => new Float32Array([1, 0])),
      embedBatch: vi.fn(async (texts: string[]) =>
        texts.map(() => new Float32Array([1, 0])),
      ),
    };

    const hybrid = new HybridSearch(bm25, vector, provider, kv as never);
    const scope = { project: "my-project", agentId: "agent-a" };
    const first = await hybrid.search("auth", 1, scope);
    const second = await hybrid.search("auth", 1, scope);

    expect(first.map((result) => result.observation.id)).toEqual(["obs_scope"]);
    expect(second.map((result) => result.observation.id)).toEqual(["obs_scope"]);
    expect(provider.embed).toHaveBeenCalledTimes(1);
  });

  it("skips observations not found in KV", async () => {
    const obs = makeObs({ id: "obs_missing", sessionId: "ses_1" });
    bm25.add(obs);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("auth");
    expect(results).toEqual([]);
  });

  it("falls back to KV.memories when an indexed entry is a saved memory (#265)", async () => {
    // mem::remember writes to KV.memories under the synthetic sessionId
    // "memory" — the BM25 index sees that synthetic sessionId, but
    // KV.observations("memory") never has anything.
    const indexable = makeObs({
      id: "mem_abc",
      sessionId: "memory",
      title: "Test memory for search",
      narrative: "Test memory for search",
      concepts: ["test", "search"],
    });
    bm25.add(indexable);

    const memory = {
      id: "mem_abc",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      type: "fact",
      title: "Test memory for search",
      content: "Test memory for search",
      concepts: ["test", "search"],
      files: [],
      sessionIds: [],
      strength: 7,
      version: 1,
      isLatest: true,
    };
    await kv.set("mem:memories", "mem_abc", memory);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("test memory search");

    expect(results.length).toBe(1);
    expect(results[0].observation.id).toBe("mem_abc");
    expect(results[0].observation.narrative).toBe("Test memory for search");
    expect(results[0].observation.concepts).toEqual(["test", "search"]);
  });

  it("enriches graph-only results by resolving their observation session (#925)", async () => {
    const obs = makeObs({
      id: "obs_graph",
      sessionId: "ses_graph",
      title: "Graph-only retrieval target",
      narrative: "A React graph node points at this observation",
      concepts: ["react"],
    });
    await kv.set("mem:sessions", "ses_graph", {
      id: "ses_graph",
      project: "p",
      cwd: "/repo",
      startedAt: new Date().toISOString(),
      status: "completed",
      observationCount: 1,
    });
    await kv.set("mem:obs:ses_graph", "obs_graph", obs);
    const node: GraphNode = {
      id: "gn_react",
      type: "library",
      name: "React",
      properties: {},
      sourceObservationIds: ["obs_graph"],
      createdAt: new Date().toISOString(),
    };
    await kv.set("mem:graph:nodes", node.id, node);

    const hybrid = new HybridSearch(bm25, null, null, kv as never);
    const results = await hybrid.search("React", 5);

    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe("obs_graph");
    expect(results[0].sessionId).toBe("ses_graph");
    expect(results[0].graphScore).toBeGreaterThan(0);
  });

  it("returns BM25 results within the graph deadline when graph retrieval is slow", async () => {
    process.env["AGENTMEMORY_GRAPH_SEARCH_TIMEOUT_MS"] = "100";
    const obs = makeObs({ id: "obs_slow_graph", title: "React auth" });
    bm25.add(obs);
    const slowKv = delayedGraphKV(500);
    await slowKv.set("mem:obs:ses_1", obs.id, obs);

    const hybrid = new HybridSearch(bm25, null, null, slowKv as never);
    const started = Date.now();
    const results = await hybrid.search("React auth", 5);

    expect(Date.now() - started).toBeLessThan(250);
    expect(results.map((result) => result.observation.id)).toContain(
      "obs_slow_graph",
    );
    expect(results[0].graphScore).toBe(0);
  });

  it("keeps BM25 and vector results when graph retrieval rejects", async () => {
    const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const obs = makeObs({ id: "obs_vector", title: "React vector result" });
    bm25.add(obs);
    const failingKv = delayedGraphKV(0, "reject");
    await failingKv.set("mem:obs:ses_1", obs.id, obs);
    const vector = {
      size: 1,
      search: async () => [
        { obsId: obs.id, sessionId: obs.sessionId, score: 0.95 },
      ],
    };
    const embeddingProvider: EmbeddingProvider = {
      dimensions: 2,
      embed: async () => new Float32Array([1, 0]),
    };

    const hybrid = new HybridSearch(
      bm25,
      vector as never,
      embeddingProvider,
      failingKv as never,
    );
    const results = await hybrid.search("React vector", 5);

    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe(obs.id);
    expect(results[0].vectorScore).toBe(0.95);
    expect(results[0].graphScore).toBe(0);
    expect(warn).toHaveBeenCalledWith(
      "Graph retrieval failed; continuing without graph results",
      expect.objectContaining({ stage: "entity lookup" }),
    );
  });

  it("includes fast graph results before the deadline", async () => {
    process.env["AGENTMEMORY_GRAPH_SEARCH_TIMEOUT_MS"] = "100";
    const obs = makeObs({ id: "obs_fast_graph", sessionId: "ses_graph" });
    bm25.add(obs);
    const graphKv = delayedGraphKV(1);
    const node: GraphNode = {
      id: "gn_react_fast",
      type: "library",
      name: "React",
      properties: {},
      sourceObservationIds: [obs.id],
      sourceSessionIds: [obs.sessionId],
      createdAt: new Date().toISOString(),
    };
    await graphKv.set("mem:graph:nodes", node.id, node);
    await graphKv.set("mem:obs:ses_graph", obs.id, obs);
    await graphKv.set("mem:sessions", "ses_graph", {
      id: "ses_graph",
      project: "p",
      cwd: "/repo",
      startedAt: new Date().toISOString(),
      status: "completed",
      observationCount: 1,
    });

    const hybrid = new HybridSearch(bm25, null, null, graphKv as never);
    const results = await hybrid.search("React", 5);

    expect(results).toHaveLength(1);
    expect(results[0].observation.id).toBe(obs.id);
    expect(results[0].graphScore).toBeGreaterThan(0);
  });
});
