import { registerWorker } from "iii-sdk";
import {
  getSearchIndexMaxItems,
  getVectorBackend,
  getLexicalBackend,
  getMetadataBackend,
  getGraphBackend,
  hydrateProcessEnvFromFile,
  loadConfig,
  loadNeo4jConfig,
  loadPostgresConfig,
  loadQdrantVectorConfig,
  loadTantivyConfig,
} from "../src/config.js";
import { createEmbeddingProvider } from "../src/providers/index.js";
import { KV } from "../src/state/schema.js";
import { StateKV } from "../src/state/kv.js";
import { PostgresKVBackend } from "../src/state/postgres-kv.js";
import { Neo4jGraphKVBackend } from "../src/state/neo4j-graph-kv.js";
import { QdrantVectorStore } from "../src/state/qdrant-vector-store.js";
import { TantivySearchIndex } from "../src/state/tantivy-search-index.js";
import {
  rebuildIndex,
  setEmbeddingProvider,
  setLexicalStore,
  setSearchIndex,
  setSearchIndexMaxItems,
  setVectorStore,
} from "../src/functions/search.js";
import type { CompressedObservation, Memory, Session } from "../src/types.js";

hydrateProcessEnvFromFile();

const config = loadConfig();
const embeddingProvider = createEmbeddingProvider();
if (!embeddingProvider) throw new Error("embedding provider unavailable");
if (getLexicalBackend() !== "tantivy") {
  throw new Error(`controlled rebuild requires Tantivy, got ${getLexicalBackend()}`);
}
if (getVectorBackend() !== "qdrant") {
  throw new Error(`controlled rebuild requires Qdrant, got ${getVectorBackend()}`);
}
if (getMetadataBackend() !== "postgres" || getGraphBackend() !== "neo4j") {
  throw new Error("controlled rebuild requires PostgreSQL metadata and Neo4j graph backends");
}

const sdk = registerWorker(config.engineUrl, {
  workerName: "agentmemory-controlled-rebuild",
  invocationTimeoutMs: 180000,
  telemetry: {
    project_name: "agentmemory",
    language: "node",
    framework: "iii-sdk",
  },
});
const postgres = new PostgresKVBackend(loadPostgresConfig());
const neo4j = new Neo4jGraphKVBackend(loadNeo4jConfig());
await postgres.ensureReady();
await neo4j.ensureReady();
const kv = new StateKV(sdk, [postgres, neo4j]);

const tantivy = new TantivySearchIndex({
  ...loadTantivyConfig(),
  maxEntries: getSearchIndexMaxItems(),
});
const qdrant = new QdrantVectorStore({
  ...loadQdrantVectorConfig(),
  dimensions: embeddingProvider.dimensions,
});
await qdrant.ensureReady();

setSearchIndexMaxItems(getSearchIndexMaxItems());
setSearchIndex(tantivy);
setLexicalStore(tantivy);
setVectorStore(qdrant);
setEmbeddingProvider(embeddingProvider);

const sessions = await kv.list<Session>(KV.sessions);
const memories = await kv.list<Memory>(KV.memories);
let observations = 0;
let eligibleObservations = 0;
for (const session of sessions) {
  const rows = await kv.list<CompressedObservation>(KV.observations(session.id));
  observations += rows.length;
  eligibleObservations += rows.filter((row) => row.title && row.narrative).length;
}
const eligibleMemories = memories.filter(
  (memory) => memory.isLatest !== false && memory.title && memory.content,
).length;
console.log(
  JSON.stringify({
    phase: "preflight",
    sessions: sessions.length,
    observations,
    eligibleObservations,
    memories: memories.length,
    eligibleMemories,
    expectedEntries: eligibleObservations + eligibleMemories,
    existingTantivyEntries: tantivy.size,
    existingQdrantPoints: qdrant.size,
  }),
);

const indexed = await rebuildIndex(kv);
console.log(
  JSON.stringify({
    phase: "complete",
    indexed,
    tantivyEntries: tantivy.size,
    qdrantPoints: qdrant.size,
  }),
);

await postgres.close();
await neo4j.close();
await sdk.shutdown();
