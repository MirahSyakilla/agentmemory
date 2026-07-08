import { mkdirSync } from "node:fs";
import type {
  BlobStoreConfig,
  Neo4jConfig,
  PostgresConfig,
  TantivyConfig,
} from "../config.js";

export interface BackendStatus {
  backend: string;
  status: "ready" | "skipped" | "error";
  details: string;
}

function formatPgConfig(config: PostgresConfig): string {
  if (config.connectionString) return "connectionString";
  return [
    config.host ?? "127.0.0.1",
    config.port ?? 5432,
    config.database ?? "agentmemory",
  ].join("/");
}

export async function probePostgres(
  config: PostgresConfig,
): Promise<BackendStatus> {
  const pg = await import("pg");
  const client = new pg.Client({
    ...(config.connectionString
      ? { connectionString: config.connectionString }
      : {
          host: config.host,
          port: config.port,
          database: config.database,
          user: config.user,
          password: config.password,
        }),
    connectionTimeoutMillis: 2000,
    ssl: config.ssl ? { rejectUnauthorized: false } : undefined,
  });
  try {
    await client.connect();
    await client.query("select 1");
    return {
      backend: "postgres",
      status: "ready",
      details: formatPgConfig(config),
    };
  } finally {
    await client.end().catch(() => {});
  }
}

export async function probeNeo4j(
  config: Neo4jConfig,
): Promise<BackendStatus> {
  if (!config.user || !config.password) {
    const httpUrl = config.url
      .replace(/^neo4j:/, "http:")
      .replace(/^bolt:/, "http:")
      .replace(/:7687$/, ":7474");
    const res = await fetch(httpUrl);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status} from ${httpUrl}`);
    }
    return {
      backend: "neo4j",
      status: "skipped",
      details: `${config.url} reachable; set AGENTMEMORY_NEO4J_USER/PASSWORD to enable queries`,
    };
  }
  const neo4j = await import("neo4j-driver");
  const driver = neo4j.default.driver(
    config.url,
    neo4j.default.auth.basic(config.user, config.password),
  );
  try {
    await driver.verifyConnectivity();
    return {
      backend: "neo4j",
      status: "ready",
      details: `${config.url}${config.database ? ` db=${config.database}` : ""}`,
    };
  } finally {
    await driver.close().catch(() => {});
  }
}

function createTantivySchema(tantivy: typeof import("@oxdev03/node-tantivy-binding")) {
  return new tantivy.SchemaBuilder()
    .addTextField("obsId", { stored: true })
    .addTextField("sessionId", { stored: true })
    .addTextField("title", { stored: true })
    .addTextField("subtitle", { stored: true })
    .addTextField("narrative", { stored: true })
    .addTextField("body", { stored: false })
    .addUnsignedField("importance", { stored: true, indexed: true, fast: true })
    .build();
}

export async function ensureTantivyReady(
  config: TantivyConfig,
): Promise<BackendStatus> {
  mkdirSync(config.path, { recursive: true });
  const tantivy = await import("@oxdev03/node-tantivy-binding");
  const schema = createTantivySchema(tantivy);
  const index = new tantivy.Index(schema, config.path, true);
  const writer = index.writer(config.heapSizeBytes, config.numThreads);
  writer.commit();
  return {
    backend: "tantivy",
    status: "ready",
    details: `${config.path} heap=${Math.round(config.heapSizeBytes / 1024 / 1024)}MB threads=${config.numThreads || "auto"}`,
  };
}

export function ensureBlobStoreReady(config: BlobStoreConfig): BackendStatus {
  mkdirSync(config.rootDir, { recursive: true });
  return {
    backend: "filesystem",
    status: "ready",
    details: config.rootDir,
  };
}
