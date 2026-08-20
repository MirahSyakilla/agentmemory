import { describe, it, expect, beforeEach, vi } from "vitest";
import { GraphRetrieval } from "../src/functions/graph-retrieval.js";
import type { GraphNode, GraphEdge, CompressedObservation, Session } from "../src/types.js";

function mockKV(
  nodes: GraphNode[] = [],
  edges: GraphEdge[] = [],
  observations: CompressedObservation[] = [],
  sessions: Session[] = [],
) {
  const store = new Map<string, Map<string, unknown>>();
  const nodesMap = new Map<string, unknown>();
  for (const n of nodes) nodesMap.set(n.id, n);
  store.set("mem:graph:nodes", nodesMap);

  const edgesMap = new Map<string, unknown>();
  for (const e of edges) edgesMap.set(e.id, e);
  store.set("mem:graph:edges", edgesMap);

  if (sessions.length > 0) {
    const sessionsMap = new Map<string, unknown>();
    for (const s of sessions) sessionsMap.set(s.id, s);
    store.set("mem:sessions", sessionsMap);
  }
  for (const obs of observations) {
    if (!store.has(`mem:obs:${obs.sessionId}`)) {
      store.set(`mem:obs:${obs.sessionId}`, new Map());
    }
    store.get(`mem:obs:${obs.sessionId}`)!.set(obs.id, obs);
  }

  const list = async <T>(scope: string): Promise<T[]> => {
    const entries = store.get(scope);
    return entries ? (Array.from(entries.values()) as T[]) : [];
  };
  const getGraphNeighborhood = async (nodeIds: string[], maxDepth: number) => {
    const graphNodes = await list<GraphNode>("mem:graph:nodes");
    const graphEdges = await list<GraphEdge>("mem:graph:edges");
    const nodeById = new Map(graphNodes.map((node) => [node.id, node]));
    const included = new Set(nodeIds);
    let frontier = nodeIds;
    for (let depth = 0; depth < maxDepth; depth++) {
      const next = new Set<string>();
      for (const edge of graphEdges) {
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
      edges: graphEdges.filter(
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

function targetedMockKV(
  nodes: GraphNode[],
  edges: GraphEdge[],
  observations: CompressedObservation[] = [],
) {
  const base = mockKV(nodes, edges, observations);
  return {
    ...base,
    findGraphNodesByNames: async (names: string[]) =>
      nodes.filter((node) =>
        names.some((name) =>
          node.name.toLowerCase().includes(name.toLowerCase()),
        ),
      ),
    findGraphNodesByObservationIds: async (obsIds: string[]) =>
      nodes.filter((node) =>
        node.sourceObservationIds.some((obsId) => obsIds.includes(obsId)),
      ),
    getGraphNeighborhood: async (nodeIds: string[], maxDepth: number) => {
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
    },
  };
}

function makeNode(
  id: string,
  name: string,
  type: GraphNode["type"] = "concept",
  obsIds: string[] = ["obs_1"],
): GraphNode {
  return {
    id,
    type,
    name,
    properties: {},
    sourceObservationIds: obsIds,
    createdAt: new Date().toISOString(),
  };
}

function makeEdge(
  id: string,
  sourceNodeId: string,
  targetNodeId: string,
  type: GraphEdge["type"] = "related_to",
  weight = 0.8,
): GraphEdge {
  return {
    id,
    type,
    sourceNodeId,
    targetNodeId,
    weight,
    sourceObservationIds: ["obs_1"],
    createdAt: new Date().toISOString(),
    tcommit: new Date().toISOString(),
    isLatest: true,
  };
}

describe("GraphRetrieval", () => {
  it("finds entities by name", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Vue", "library", ["obs_2"]),
    ];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"]);
    expect(results.length).toBeGreaterThan(0);
    expect(results[0].obsId).toBe("obs_1");
  });

  it("filters graph candidates by session scope before ranking", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_in_scope"]),
      makeNode("n2", "React", "library", ["obs_other"]),
    ];
    const observations: CompressedObservation[] = [
      {
        id: "obs_in_scope",
        sessionId: "ses_scope",
        timestamp: new Date().toISOString(),
        type: "file_edit",
        title: "Scoped React edit",
        facts: [],
        narrative: "Scoped React work",
        concepts: ["react"],
        files: [],
        importance: 5,
      },
      {
        id: "obs_other",
        sessionId: "ses_other",
        timestamp: new Date().toISOString(),
        type: "file_edit",
        title: "Other React edit",
        facts: [],
        narrative: "Other React work",
        concepts: ["react"],
        files: [],
        importance: 5,
      },
    ];
    const sessions: Session[] = [
      {
        id: "ses_scope",
        project: "my-project",
        cwd: "/repo",
        startedAt: new Date().toISOString(),
        status: "completed",
        observationCount: 1,
      },
      {
        id: "ses_other",
        project: "other-project",
        cwd: "/repo",
        startedAt: new Date().toISOString(),
        status: "completed",
        observationCount: 1,
      },
    ];
    const retrieval = new GraphRetrieval(
      mockKV(nodes, [], observations, sessions) as never,
    );

    const results = await retrieval.searchByEntities(
      ["React"],
      2,
      1,
      { project: "my-project" },
    );

    expect(results).toEqual([
      expect.objectContaining({ obsId: "obs_in_scope", sessionId: "ses_scope" }),
    ]);
  });

  it("resolves sessionId for legacy graph nodes by scanning observations (#925)", async () => {
    const nodes = [makeNode("n1", "React", "library", ["obs_1"])];
    const sessions: Session[] = [
      {
        id: "ses_1",
        project: "demo",
        cwd: "/repo",
        startedAt: new Date().toISOString(),
        status: "completed",
        observationCount: 1,
      },
    ];
    const observations: CompressedObservation[] = [
      {
        id: "obs_1",
        sessionId: "ses_1",
        timestamp: new Date().toISOString(),
        type: "file_edit",
        title: "React edit",
        facts: [],
        narrative: "Touched React code",
        concepts: ["react"],
        files: ["src/app.tsx"],
        importance: 5,
      },
    ];
    const kv = mockKV(nodes, [], observations, sessions);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"]);
    expect(results[0].sessionId).toBe("ses_1");
  });

  it("finds entities by partial name match", async () => {
    const nodes = [makeNode("n1", "auth-middleware", "function", ["obs_1"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["auth"]);
    expect(results.length).toBeGreaterThan(0);
  });

  it("uses targeted graph backend operations when available", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Component", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = targetedMockKV(nodes, edges);
    const list = vi.fn(async (scope: string) => {
      if (scope === "mem:graph:nodes" || scope === "mem:graph:edges") {
        throw new Error("full graph enumeration must not run");
      }
      return kv.list(scope);
    });
    const retrieval = new GraphRetrieval({ ...kv, list } as never);

    const results = await retrieval.searchByEntities(["React"], 2);

    expect(results.map((result) => result.obsId)).toEqual(
      expect.arrayContaining(["obs_1", "obs_2"]),
    );
    expect(list).not.toHaveBeenCalledWith("mem:graph:nodes");
    expect(list).not.toHaveBeenCalledWith("mem:graph:edges");
  });

  it("does not enumerate graph scopes when targeted retrieval is unavailable", async () => {
    const base = mockKV(
      [makeNode("n1", "React", "library", ["obs_1"])],
      [],
    );
    const {
      findGraphNodesByNames: _findGraphNodesByNames,
      findGraphNodesByObservationIds: _findGraphNodesByObservationIds,
      getGraphNeighborhood: _getGraphNeighborhood,
      ...legacyKv
    } = base;
    const list = vi.fn(legacyKv.list);
    const retrieval = new GraphRetrieval({ ...legacyKv, list } as never);

    await expect(retrieval.searchByEntities(["React"])).resolves.toEqual([]);
    expect(list).not.toHaveBeenCalledWith("mem:graph:nodes");
    expect(list).not.toHaveBeenCalledWith("mem:graph:edges");
  });

  it("traverses graph edges to find related observations", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Component", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_1");
    expect(obsIds).toContain("obs_2");
  });

  it("returns empty for no matches", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const results = await retrieval.searchByEntities(["nonexistent"]);
    expect(results).toEqual([]);
  });

  it("expands from existing chunks", async () => {
    const nodes = [
      makeNode("n1", "auth.ts", "file", ["obs_1"]),
      makeNode("n2", "jwt", "concept", ["obs_2"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses")];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).toContain("obs_2");
  });

  it("does not duplicate already-seen observations in expansion", async () => {
    const nodes = [makeNode("n1", "file.ts", "file", ["obs_1", "obs_2"])];
    const kv = mockKV(nodes, []);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.expandFromChunks(["obs_1"]);
    const obsIds = results.map((r) => r.obsId);
    expect(obsIds).not.toContain("obs_1");
  });

  it("performs temporal query - current state", async () => {
    const nodes = [makeNode("n1", "Alice", "person", ["obs_1"])];
    const edges = [
      makeEdge("e1", "n1", "n1", "located_in" as any, 0.9),
      {
        ...makeEdge("e2", "n1", "n1", "located_in" as any, 0.9),
        tvalid: "2024-06-01",
        isLatest: true,
      },
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const result = await retrieval.temporalQuery("Alice");
    expect(result.entity).toBeDefined();
    expect(result.entity!.name).toBe("Alice");
    expect(result.currentState.length).toBeGreaterThan(0);
  });

  it("returns null entity for unknown name", async () => {
    const kv = mockKV([], []);
    const retrieval = new GraphRetrieval(kv as never);
    const result = await retrieval.temporalQuery("Unknown");
    expect(result.entity).toBeNull();
  });

  it("scores closer paths higher", async () => {
    const nodes = [
      makeNode("n1", "React", "library", ["obs_1"]),
      makeNode("n2", "Hook", "concept", ["obs_2"]),
      makeNode("n3", "State", "concept", ["obs_3"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "uses", 0.9),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 3);
    const directScore = results.find((r) => r.obsId === "obs_1")?.score ?? 0;
    const indirectScore = results.find((r) => r.obsId === "obs_3")?.score ?? 0;
    expect(directScore).toBeGreaterThan(indirectScore);
  });

  // Dijkstra path selection (#328). The BFS implementation this
  // replaced visited a node via its first-discovered path regardless
  // of edge weight. Dijkstra picks the highest-weight (lowest
  // 1/weight cost) path, so a one-hop weak edge no longer beats a
  // two-hop chain of strong edges to the same node.
  it("picks the weight-optimal path under Dijkstra, not the edge-count-shortest one (#328)", async () => {
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_start"]),
      makeNode("n2", "Mid", "concept", ["obs_mid"]),
      makeNode("n3", "End", "concept", ["obs_end"]),
    ];
    const edges = [
      // Direct n1 → n3 path with a weak edge. BFS would prefer this.
      makeEdge("e_direct", "n1", "n3", "related_to", 0.15),
      // Two-hop chain n1 → n2 → n3 with strong edges. Total cost
      // (1/0.9) + (1/0.9) ≈ 2.22, vs direct 1/0.15 ≈ 6.67.
      // Dijkstra picks the chain.
      makeEdge("e_strong_a", "n1", "n2", "related_to", 0.9),
      makeEdge("e_strong_b", "n2", "n3", "related_to", 0.9),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 3);
    const endResult = results.find((r) => r.obsId === "obs_end");
    expect(endResult).toBeDefined();
    // Path is [Start → Mid → End] (length 3) — Dijkstra picked the
    // chain of two strong edges over the direct weak one.
    expect(endResult!.pathLength).toBe(3);
    expect(endResult!.graphContext).toContain("Mid");
  });

  it("handles disconnected nodes without crashing", async () => {
    const nodes = [
      makeNode("n1", "A", "concept", ["obs_a"]),
      makeNode("n2", "B", "concept", ["obs_b"]),
      // n3 is unreachable from the matched node.
      makeNode("n3", "Lonely", "concept", ["obs_lonely"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0.7)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["A"], 5);
    expect(results.find((r) => r.obsId === "obs_a")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_b")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_lonely")).toBeUndefined();
  });

  it("clamps near-zero edge weights without dividing by zero", async () => {
    const nodes = [
      makeNode("n1", "Anchor", "concept", ["obs_anchor"]),
      makeNode("n2", "Weak", "concept", ["obs_weak"]),
    ];
    // weight: 0 is malformed but we shouldn't crash on it; the clamp
    // floor at 0.01 means traversal completes with a very high cost
    // rather than throwing or producing Infinity.
    const edges = [makeEdge("e1", "n1", "n2", "related_to", 0)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Anchor"], 2);
    const weak = results.find((r) => r.obsId === "obs_weak");
    expect(weak).toBeDefined();
    expect(Number.isFinite(weak!.score)).toBe(true);
  });

  it("scores startNode observations at 1.0 via the fallback path, not 0.5 via the path-scoring loop (#328 review)", async () => {
    // Regression for a bug surfaced by inline review on #463: if the
    // traversal includes a length-1 path for the startNode itself,
    // the generic path-scoring loop in searchByEntities computes
    // avgWeight=0.5 (empty edgeWeights → fallback) and pathLength=1,
    // yielding score=0.5, then marks the obs as visited. The
    // dedicated score=1.0 fallback loop for startNode obs is then
    // skipped via the visitedObs guard — dead code.
    const nodes = [
      makeNode("n1", "React", "library", ["obs_root"]),
      makeNode("n2", "Hook", "concept", ["obs_neighbor"]),
    ];
    const edges = [makeEdge("e1", "n1", "n2", "uses", 0.8)];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["React"], 2);
    const root = results.find((r) => r.obsId === "obs_root");
    expect(root).toBeDefined();
    expect(root!.score).toBe(1.0);
    expect(root!.pathLength).toBe(0);
  });

  it("respects maxDepth bound (Dijkstra stops at edge-count depth)", async () => {
    // Chain n1 -> n2 -> n3 -> n4. With maxDepth=2 we should reach n3
    // but not n4 — edge-count semantics preserved from the old BFS.
    const nodes = [
      makeNode("n1", "Start", "concept", ["obs_1"]),
      makeNode("n2", "Hop1", "concept", ["obs_2"]),
      makeNode("n3", "Hop2", "concept", ["obs_3"]),
      makeNode("n4", "Hop3", "concept", ["obs_4"]),
    ];
    const edges = [
      makeEdge("e1", "n1", "n2", "related_to", 0.8),
      makeEdge("e2", "n2", "n3", "related_to", 0.8),
      makeEdge("e3", "n3", "n4", "related_to", 0.8),
    ];
    const kv = mockKV(nodes, edges);
    const retrieval = new GraphRetrieval(kv as never);

    const results = await retrieval.searchByEntities(["Start"], 2);
    expect(results.find((r) => r.obsId === "obs_3")).toBeDefined();
    expect(results.find((r) => r.obsId === "obs_4")).toBeUndefined();
  });
});
