import type {
  CompressedObservation,
  GraphNode,
  GraphEdge,
  Session,
} from "../types.js";
import { KV } from "../state/schema.js";
import type { StateKV } from "../state/kv.js";

export interface GraphRetrievalResult {
  obsId: string;
  sessionId: string;
  score: number;
  graphContext: string;
  pathLength: number;
}

export interface GraphRetrievalOptions {
  timeoutMs?: number;
  signal?: AbortSignal;
  project?: string;
  agentId?: string;
}

function throwIfAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  if (signal.reason instanceof Error) throw signal.reason;
  const error = new Error("Graph retrieval aborted");
  error.name = "AbortError";
  throw error;
}

function buildGraphContext(
  path: Array<{ node: GraphNode; edge?: GraphEdge }>,
): string {
  const parts: string[] = [];
  for (const step of path) {
    const props = Object.entries(step.node.properties)
      .slice(0, 3)
      .map(([k, v]) => `${k}=${v}`)
      .join(", ");
    let line = `[${step.node.type}] ${step.node.name}`;
    if (props) line += ` (${props})`;
    if (step.edge) {
      line += ` --${step.edge.type}-->`;
      if (step.edge.context?.reasoning) {
        line += ` [${step.edge.context.reasoning}]`;
      }
      if (step.edge.tvalid) {
        line += ` @${step.edge.tvalid}`;
      }
    }
    parts.push(line);
  }
  return parts.join(" ");
}

export class GraphRetrieval {
  private obsSessionCache: Map<string, string | null> | null = null;
  private sessionScopeCache = new Map<string, Session | null>();

  constructor(private kv: StateKV) {}

  private sessionIdFromNode(node: GraphNode, obsId: string): string | undefined {
    const idx = (node.sourceObservationIds ?? []).indexOf(obsId);
    return node.sourceSessionIds?.[idx] || node.sourceSessionIds?.[0];
  }

  private async loadObservationSessionIndex(
    options: GraphRetrievalOptions = {},
  ): Promise<Map<string, string | null>> {
    if (this.obsSessionCache) return this.obsSessionCache;
    const cache = new Map<string, string | null>();
    const sessions = await this.listState<Session>(KV.sessions, options).catch(() => []);
    throwIfAborted(options.signal);
    await Promise.all(
      sessions.map(async (session) => {
        const observations = await this.listState<CompressedObservation>(
          KV.observations(session.id),
          options,
        )
          .catch(() => []);
        for (const obs of observations) {
          cache.set(obs.id, obs.sessionId || session.id);
        }
      }),
    );
    throwIfAborted(options.signal);
    this.obsSessionCache = cache;
    return cache;
  }

  private async resolveSessionId(
    node: GraphNode,
    obsId: string,
    options: GraphRetrievalOptions = {},
  ): Promise<string> {
    const direct = this.sessionIdFromNode(node, obsId);
    if (direct) return direct;
    const sessionIndex = await this.loadObservationSessionIndex(options);
    return sessionIndex.get(obsId) ?? "";
  }

  private async matchesScope(
    sessionId: string,
    options: GraphRetrievalOptions,
  ): Promise<boolean> {
    if (!options.project && !options.agentId) return true;
    if (!sessionId) return false;
    if (!this.sessionScopeCache.has(sessionId)) {
      this.sessionScopeCache.set(
        sessionId,
        await this.kv.get<Session>(KV.sessions, sessionId).catch(() => null),
      );
    }
    const session = this.sessionScopeCache.get(sessionId);
    return Boolean(
      session &&
        (!options.project || session.project === options.project) &&
        (!options.agentId || session.agentId === options.agentId),
    );
  }

  private async resultFor(
    node: GraphNode,
    obsId: string,
    score: number,
    graphContext: string,
    pathLength: number,
    options: GraphRetrievalOptions,
  ): Promise<GraphRetrievalResult> {
    return {
      obsId,
      sessionId: await this.resolveSessionId(node, obsId, options),
      score,
      graphContext,
      pathLength,
    };
  }

  async searchByEntities(
    entityNames: string[],
    maxDepth = 2,
    maxResults = 20,
    options: GraphRetrievalOptions = {},
  ): Promise<GraphRetrievalResult[]> {
    return this.searchByEntitiesTargeted(
      entityNames,
      maxDepth,
      maxResults,
      options,
    );
  }

  async expandFromChunks(
    obsIds: string[],
    maxDepth = 1,
    maxResults = 10,
    options: GraphRetrievalOptions = {},
  ): Promise<GraphRetrievalResult[]> {
    return this.expandFromChunksTargeted(
      obsIds,
      maxDepth,
      maxResults,
      options,
    );
  }

  private async listState<T>(
    scope: string,
    options: GraphRetrievalOptions,
  ): Promise<T[]> {
    if (
      typeof options.timeoutMs === "number" &&
      typeof this.kv.listWithTimeout === "function"
    ) {
      return this.kv.listWithTimeout<T>(
        scope,
        options.timeoutMs,
        options.signal,
      );
    }
    return this.kv.list<T>(scope);
  }

  private async searchByEntitiesTargeted(
    entityNames: string[],
    maxDepth: number,
    maxResults: number,
    options: GraphRetrievalOptions,
  ): Promise<GraphRetrievalResult[]> {
    if (
      typeof this.kv.findGraphNodesByNames !== "function" ||
      typeof this.kv.getGraphNeighborhood !== "function"
    ) {
      return [];
    }
    const nodes = await this.kv.findGraphNodesByNames(
      entityNames,
      Math.max(maxResults * 2, 20),
      options,
    );
    if (nodes === null) return [];
    throwIfAborted(options.signal);
    if (nodes.length === 0) return [];

    const neighborhood = await this.kv.getGraphNeighborhood(
      nodes.map((node) => node.id),
      maxDepth,
      Math.max(maxResults * 8, 100),
      options,
    );
    if (neighborhood === null) return [];
    return this.rankGraphResults(
      nodes,
      neighborhood.nodes,
      neighborhood.edges,
      maxDepth,
      maxResults,
      "entity",
      options,
    );
  }

  private async expandFromChunksTargeted(
    obsIds: string[],
    maxDepth: number,
    maxResults: number,
    options: GraphRetrievalOptions,
  ): Promise<GraphRetrievalResult[]> {
    if (
      typeof this.kv.findGraphNodesByObservationIds !== "function" ||
      typeof this.kv.getGraphNeighborhood !== "function"
    ) {
      return [];
    }
    const linkedNodes = await this.kv.findGraphNodesByObservationIds(
      obsIds,
      Math.max(maxResults * 2, 20),
      options,
    );
    if (linkedNodes === null) return [];
    throwIfAborted(options.signal);
    if (linkedNodes.length === 0) return [];
    const neighborhood = await this.kv.getGraphNeighborhood(
      linkedNodes.map((node) => node.id),
      maxDepth,
      Math.max(maxResults * 8, 100),
      options,
    );
    if (neighborhood === null) return [];
    return this.rankGraphResults(
      linkedNodes,
      neighborhood.nodes,
      neighborhood.edges,
      maxDepth,
      maxResults,
      "expansion",
      options,
      new Set(obsIds),
    );
  }

  private async rankGraphResults(
    startNodes: GraphNode[],
    allNodes: GraphNode[],
    allEdges: GraphEdge[],
    maxDepth: number,
    maxResults: number,
    mode: "entity" | "expansion",
    options: GraphRetrievalOptions,
    initiallyVisited = new Set<string>(),
  ): Promise<GraphRetrievalResult[]> {
    const nodeMap = new Map(allNodes.map((node) => [node.id, node]));
    const results: GraphRetrievalResult[] = [];
    const visitedObs = initiallyVisited;
    for (const startNode of startNodes) {
      throwIfAborted(options.signal);
      const actualStart = nodeMap.get(startNode.id) ?? startNode;
      const paths = this.dijkstraTraversal(actualStart, allNodes, allEdges, maxDepth);
      for (const path of paths) {
        throwIfAborted(options.signal);
        const lastNode = path[path.length - 1].node;
        for (const obsId of lastNode.sourceObservationIds ?? []) {
          throwIfAborted(options.signal);
          if (visitedObs.has(obsId)) continue;
          const result = await this.resultFor(
            lastNode,
            obsId,
            this.scorePath(path, mode),
            buildGraphContext(path),
            path.length,
            options,
          );
          if (await this.matchesScope(result.sessionId, options)) {
            visitedObs.add(obsId);
            results.push(result);
          }
        }
      }
      if (mode === "entity") {
        for (const obsId of actualStart.sourceObservationIds ?? []) {
          throwIfAborted(options.signal);
          if (visitedObs.has(obsId)) continue;
          const result = await this.resultFor(
            actualStart,
            obsId,
            1,
            `[${actualStart.type}] ${actualStart.name}`,
            0,
            options,
          );
          if (await this.matchesScope(result.sessionId, options)) {
            visitedObs.add(obsId);
            results.push(result);
          }
        }
      }
    }
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, maxResults);
  }

  private scorePath(
    path: Array<{ node: GraphNode; edge?: GraphEdge }>,
    mode: "entity" | "expansion",
  ): number {
    if (mode === "expansion") return 0.5 * (1 / (path.length + 1));
    const weights = path
      .filter((step) => step.edge)
      .map((step) => step.edge!.weight);
    const averageWeight =
      weights.length > 0
        ? weights.reduce((sum, weight) => sum + weight, 0) / weights.length
        : 0.5;
    return averageWeight * (1 / path.length);
  }

  async temporalQuery(
    entityName: string,
    asOf?: string,
  ): Promise<{
    entity: GraphNode | null;
    currentState: GraphEdge[];
    history: GraphEdge[];
  }> {
    const allNodes = (await this.kv.list<GraphNode>(KV.graphNodes)).filter((n) => !n.stale);
    const allEdges = (await this.kv.list<GraphEdge>(KV.graphEdges)).filter((e) => !e.stale);

    const entity = allNodes.find(
      (n) => n.name.toLowerCase() === entityName.toLowerCase(),
    );
    if (!entity) return { entity: null, currentState: [], history: [] };

    const relatedEdges = allEdges.filter(
      (e) => e.sourceNodeId === entity.id || e.targetNodeId === entity.id,
    );

    if (!asOf) {
      const latestEdges = this.getLatestEdges(relatedEdges);
      const historicalEdges = relatedEdges.filter(
        (e) => !latestEdges.some((le) => le.id === e.id),
      );
      return { entity, currentState: latestEdges, history: historicalEdges };
    }

    const asOfDate = new Date(asOf).getTime();
    const validEdges = relatedEdges.filter((e) => {
      const commitDate = new Date(e.tcommit || e.createdAt).getTime();
      if (commitDate > asOfDate) return false;
      if (e.tvalid) {
        const validDate = new Date(e.tvalid).getTime();
        if (validDate > asOfDate) return false;
      }
      if (e.tvalidEnd) {
        const endDate = new Date(e.tvalidEnd).getTime();
        if (endDate < asOfDate) return false;
      }
      return true;
    });

    return {
      entity,
      currentState: this.getLatestEdges(validEdges),
      history: validEdges,
    };
  }

  private getLatestEdges(edges: GraphEdge[]): GraphEdge[] {
    const byKey = new Map<string, GraphEdge[]>();
    for (const e of edges) {
      const key = `${e.sourceNodeId}|${e.targetNodeId}|${e.type}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key)!.push(e);
    }

    const latest: GraphEdge[] = [];
    for (const group of byKey.values()) {
      if (group.length === 0) continue;
      group.sort(
        (a, b) =>
          new Date(b.tcommit || b.createdAt).getTime() -
          new Date(a.tcommit || a.createdAt).getTime(),
      );
      const newest = group.find((e) => e.isLatest !== false) || group[0];
      latest.push(newest);
    }
    return latest;
  }

  // Weighted shortest-path traversal (#328). Replaces the prior BFS,
  // which fell back to edge-count order and ignored the 0.1-1.0 weight
  // attached to every graph edge. Dijkstra over `cost = 1/weight`
  // (cheaper edges = stronger relationships) returns the
  // highest-weighted path to each reachable node within maxDepth. Also
  // tightens the perf profile:
  //   - Adjacency built once in O(V+E) (previous BFS re-filtered
  //     allEdges per visited node, O(V·E) overall).
  //   - Min-heap dequeue is O(log V) per pop (previous queue.shift()
  //     was O(n) — the dominant cost on graphs above ~200 nodes per
  //     the contributor's benchmark in #328).
  private dijkstraTraversal(
    startNode: GraphNode,
    allNodes: GraphNode[],
    allEdges: GraphEdge[],
    maxDepth: number,
  ): Array<Array<{ node: GraphNode; edge?: GraphEdge }>> {
    const nodeIndex = new Map<string, GraphNode>();
    for (const n of allNodes) nodeIndex.set(n.id, n);

    const adjacency = new Map<string, Array<{ neighborId: string; edge: GraphEdge }>>();
    for (const edge of allEdges) {
      const a = edge.sourceNodeId;
      const b = edge.targetNodeId;
      if (!adjacency.has(a)) adjacency.set(a, []);
      if (!adjacency.has(b)) adjacency.set(b, []);
      adjacency.get(a)!.push({ neighborId: b, edge });
      adjacency.get(b)!.push({ neighborId: a, edge });
    }

    const dist = new Map<string, number>();
    const pathTo = new Map<string, Array<{ node: GraphNode; edge?: GraphEdge }>>();
    dist.set(startNode.id, 0);
    pathTo.set(startNode.id, [{ node: startNode }]);

    const heap = new MinHeap<{ nodeId: string; depth: number; cost: number }>(
      (a, b) => a.cost - b.cost,
    );
    heap.push({ nodeId: startNode.id, depth: 0, cost: 0 });

    while (heap.size() > 0) {
      const { nodeId, depth, cost } = heap.pop()!;
      // Skip stale heap entries (cost beaten by a later push).
      if (cost > (dist.get(nodeId) ?? Infinity)) continue;
      if (depth >= maxDepth) continue;

      const neighbors = adjacency.get(nodeId) ?? [];
      for (const { neighborId, edge } of neighbors) {
        const nextNode = nodeIndex.get(neighborId);
        if (!nextNode) continue;
        // Clamp weight to avoid division-by-zero on malformed edges;
        // 0.01 is below the documented 0.1 floor.
        const edgeCost = 1 / Math.max(edge.weight, 0.01);
        const newCost = cost + edgeCost;
        if (newCost < (dist.get(neighborId) ?? Infinity)) {
          dist.set(neighborId, newCost);
          pathTo.set(neighborId, [
            ...pathTo.get(nodeId)!,
            { node: nextNode, edge },
          ]);
          heap.push({ nodeId: neighborId, depth: depth + 1, cost: newCost });
        }
      }
    }

    // Drop the startNode's own entry before returning: callers
    // (searchByEntities, expandFromChunks) score start-node
    // observations via a dedicated fallback loop with score=1.0. If
    // we leave it in here, the start-path (length 1, no edges) goes
    // through the generic path-scoring loop first — pathLength=1 +
    // empty edgeWeights makes avgWeight fall to 0.5, the obs get
    // marked visited, and the score=1.0 fallback becomes dead code.
    pathTo.delete(startNode.id);
    return Array.from(pathTo.values());
  }
}

// Minimal binary min-heap. Pulled inline so graph-retrieval doesn't
// take a new dependency for the perf-critical inner loop of #328.
// Comparator returns negative when `a` should pop before `b`.
class MinHeap<T> {
  private heap: T[] = [];

  constructor(private compare: (a: T, b: T) => number) {}

  size(): number {
    return this.heap.length;
  }

  push(value: T): void {
    this.heap.push(value);
    this.bubbleUp(this.heap.length - 1);
  }

  pop(): T | undefined {
    if (this.heap.length === 0) return undefined;
    const top = this.heap[0];
    const last = this.heap.pop()!;
    if (this.heap.length > 0) {
      this.heap[0] = last;
      this.sinkDown(0);
    }
    return top;
  }

  private bubbleUp(i: number): void {
    while (i > 0) {
      const parent = (i - 1) >> 1;
      if (this.compare(this.heap[i], this.heap[parent]) < 0) {
        [this.heap[i], this.heap[parent]] = [this.heap[parent], this.heap[i]];
        i = parent;
      } else break;
    }
  }

  private sinkDown(i: number): void {
    const n = this.heap.length;
    while (true) {
      const left = 2 * i + 1;
      const right = 2 * i + 2;
      let smallest = i;
      if (left < n && this.compare(this.heap[left], this.heap[smallest]) < 0) {
        smallest = left;
      }
      if (right < n && this.compare(this.heap[right], this.heap[smallest]) < 0) {
        smallest = right;
      }
      if (smallest === i) break;
      [this.heap[i], this.heap[smallest]] = [this.heap[smallest], this.heap[i]];
      i = smallest;
    }
  }
}
