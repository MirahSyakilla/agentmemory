# AgentMemory External-Backend Fork

Persistent memory for coding agents, built on the [iii engine](https://github.com/iii-hq/iii). It captures agent activity, stores durable observations and decisions, and returns relevant context through MCP, REST, hooks, and the local viewer.

This repository is a maintained fork of [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory), currently based on upstream `v0.9.29`. It keeps the upstream agent integrations and memory model, but deliberately changes the storage and deployment model for persistent multi-service operation.

## What It Does

- Captures prompts, tool use, file work, session milestones, and explicit memory saves.
- Searches memories through lexical, vector, and graph signals.
- Serves 54 MCP tools. Its full MCP surface is 54 tools, 6 resources, 3 prompts, and 17 skills.
- Exposes 133 endpoints on port `3111`, with the viewer on `127.0.0.1:3113`.
- Supports Claude Code, Codex, OpenCode, Cursor, Copilot CLI, pi, Devin, Droid, Antigravity, and MCP-capable clients.
- Keeps session history, lessons, relations, audit records, graph data, exports, and backups separate from the agent's working repository.

## Fork Versus Upstream

The upstream project is the source of the feature set and integration model. This fork is intended for users who want those capabilities backed by explicit production-style services rather than a local-only storage path.

| Area | Upstream `rohitg00/agentmemory` | This fork |
|---|---|---|
| Primary goal | Local-first agent memory with a minimal first-run path | Durable external-backend deployment for a persistent local or self-hosted service |
| Metadata and sessions | iii state / local project runtime path | PostgreSQL is mandatory |
| Vector search | In-process or local vector option depending on configuration | Qdrant is mandatory |
| Knowledge graph | iii KV graph path available | Neo4j is mandatory |
| Lexical search | In-memory / persisted local index options | Tantivy is mandatory on the local filesystem |
| Blobs and large payloads | Inline or local options | Filesystem blob store is mandatory |
| Backend selection flags | Selectable according to upstream configuration | Compatibility flags are accepted but ignored; the required backend is logged at startup |
| First boot | Can run in a reduced local mode | Requires PostgreSQL, Qdrant, and Neo4j to be reachable before the worker starts |
| Operational model | Convenient single-machine default | Explicit service health, backups, volumes, credentials, and endpoint configuration |
| Compatibility | Canonical behavior and release notes | Inherits the public MCP, REST, hook, plugin, and skill surfaces, but is not a storage-compatible drop-in replacement |

### Important Migration Notes

- Do not point both upstream and this fork at the same storage blindly. Their persistence assumptions differ.
- Export upstream data before moving. Import through the supported import endpoints or CLI after the fork's backend services are online.
- Back up PostgreSQL, Qdrant, Neo4j, the Tantivy directory, and the blob directory together. A database-only backup is incomplete.
- `AGENTMEMORY_VECTOR_BACKEND`, `AGENTMEMORY_METADATA_BACKEND`, `AGENTMEMORY_GRAPH_BACKEND`, `AGENTMEMORY_LEXICAL_BACKEND`, and `AGENTMEMORY_BLOB_BACKEND` do not switch this fork back to memory or iii-KV storage. Startup warns when they are set to an unsupported value.
- The upstream README remains the best source for general feature background. This README documents how this fork operates differently.

## Architecture

```text
Coding agents and plugins
        |
        | MCP, REST, hooks
        v
agentmemory worker + iii engine
        |
        +-- PostgreSQL: sessions, memories, audit, state
        +-- Qdrant: embeddings and vector search
        +-- Neo4j: graph nodes and relationships
        +-- Tantivy: lexical index on local disk
        +-- Filesystem: blobs, snapshots, exports
```

The worker still uses iii functions and triggers. The fork changes where durable data is stored, not the core function-driven architecture.

## Requirements

- Node.js 20 or newer.
- Docker or reachable PostgreSQL, Qdrant, and Neo4j services.
- The pinned iii engine, managed by the CLI or started with the included `docker-compose.yml`.
- Enough local disk for Tantivy, blob files, snapshots, and exported archives.

Default local endpoints are:

| Service | Default |
|---|---|
| AgentMemory REST | `http://127.0.0.1:3111` |
| iii streams | `ws://127.0.0.1:3112` |
| Viewer | `http://127.0.0.1:3113` |
| iii engine | `ws://127.0.0.1:49134` |
| PostgreSQL | `127.0.0.1:5432`, database `agentmemory` |
| Qdrant | `http://127.0.0.1:6333` |
| Neo4j Bolt | `neo4j://127.0.0.1:7687` |

## Quick Setup

### 1. Clone and configure

```bash
git clone https://github.com/MirahSyakilla/agentmemory.git
cd agentmemory

mkdir -p ~/.agentmemory
cp .env.example ~/.agentmemory/.env
```

Edit `~/.agentmemory/.env` before starting the worker. At minimum, set the passwords and URLs that differ from the defaults:

```dotenv
AGENTMEMORY_PG_URL=postgresql://agentmemory:change-me@127.0.0.1:5432/agentmemory
AGENTMEMORY_QDRANT_URL=http://127.0.0.1:6333
AGENTMEMORY_NEO4J_URL=neo4j://127.0.0.1:7687
AGENTMEMORY_NEO4J_USER=neo4j
AGENTMEMORY_NEO4J_PASSWORD=change-me

# Recommended when the REST API is exposed through a proxy or tunnel.
AGENTMEMORY_SECRET=replace-with-a-long-random-secret
```

### 2. Start required backends

Use existing managed services, or run local containers. The following commands are a development example; choose persistent volumes and production credentials before exposing anything beyond localhost.

```bash
docker run -d --name agentmemory-postgres \
  -e POSTGRES_DB=agentmemory \
  -e POSTGRES_USER=agentmemory \
  -e POSTGRES_PASSWORD=change-me \
  -p 127.0.0.1:5432:5432 \
  postgres:16

docker run -d --name agentmemory-qdrant \
  -p 127.0.0.1:6333:6333 \
  qdrant/qdrant:latest

docker run -d --name agentmemory-neo4j \
  -e NEO4J_AUTH=neo4j/change-me \
  -p 127.0.0.1:7474:7474 \
  -p 127.0.0.1:7687:7687 \
  neo4j:5
```

Start the iii engine from this checkout:

```bash
docker compose up -d
```

`docker-compose.yml` starts the pinned iii engine. It does not replace PostgreSQL, Qdrant, or Neo4j.

### 3. Build and run the worker

```bash
npm ci
npm run build
npm start
```

The worker checks its required backends during startup. A failed PostgreSQL, Qdrant, or Neo4j connection is a configuration error, not a reduced-mode fallback.

### 4. Verify health

```bash
curl -fsS http://127.0.0.1:3111/agentmemory/livez
curl -fsS http://127.0.0.1:3111/agentmemory/health
```

The first response confirms the service is running. The second must report `"status":"healthy"` and connected backend state. Open `http://127.0.0.1:3113` for the viewer.

## Configure an Agent

Build first, then wire the local worker into an agent configuration:

```bash
node dist/cli.mjs connect codex --force --with-hooks
node dist/cli.mjs connect opencode --force
node dist/cli.mjs connect claude-code --force --with-hooks
```

Use `node dist/cli.mjs connect <agent>` for other adapters. The command merges AgentMemory's MCP configuration without removing other MCP servers.

For Codex specifically:

- `connect codex --with-hooks` writes the global hook fallback used by current Codex desktop builds.
- Launch Codex once after changing hooks and approve the refreshed hook hashes.
- Start a new Codex thread after updating the AgentMemory skill plugin; skills are discovered at thread start.

For any MCP-only client, configure the local standalone bridge:

```json
{
  "mcpServers": {
    "agentmemory": {
      "command": "node",
      "args": ["/absolute/path/to/agentmemory/dist/standalone.mjs"],
      "env": {
        "AGENTMEMORY_URL": "http://127.0.0.1:3111",
        "AGENTMEMORY_TOOLS": "all"
      }
    }
  }
}
```

If `AGENTMEMORY_SECRET` is configured, provide it as `AGENTMEMORY_SECRET` to the bridge and use a bearer token for REST calls.

## Everyday Use

The normal loop is simple:

1. Start the worker and required services.
2. Let hooks capture activity, or explicitly save durable decisions with `memory_save`.
3. Recall context with `memory_recall` or `memory_smart_search` before non-trivial work.
4. Use the viewer to inspect session capture, retrieval, graph state, health, and audit entries.

Useful endpoints:

```bash
# Save a fact directly through REST.
curl -X POST http://127.0.0.1:3111/agentmemory/remember \
  -H 'Content-Type: application/json' \
  -d '{"content":"Use PostgreSQL for metadata in this fork","concepts":["architecture","storage"]}'

# Retrieve matching context.
curl -X POST http://127.0.0.1:3111/agentmemory/smart-search \
  -H 'Content-Type: application/json' \
  -d '{"query":"which storage backend keeps metadata?","limit":5}'

# Inspect compact graph data suitable for a UI client.
curl -X POST http://127.0.0.1:3111/agentmemory/graph/query \
  -H 'Content-Type: application/json' \
  -d '{"limit":500,"compact":true}'
```

When authentication is enabled, add:

```bash
-H "Authorization: Bearer $AGENTMEMORY_SECRET"
```

## Configuration Reference

The full list is in [`.env.example`](.env.example). The settings most relevant to this fork are:

| Variable | Purpose |
|---|---|
| `AGENTMEMORY_PG_URL` | PostgreSQL connection string; `DATABASE_URL` is also accepted |
| `AGENTMEMORY_QDRANT_URL` | Qdrant base URL |
| `AGENTMEMORY_QDRANT_COLLECTION` | Qdrant collection name, default `agentmemory_vectors` |
| `AGENTMEMORY_NEO4J_URL` | Neo4j Bolt URL |
| `AGENTMEMORY_NEO4J_USER` / `AGENTMEMORY_NEO4J_PASSWORD` | Neo4j credentials |
| `AGENTMEMORY_TANTIVY_PATH` | Local Tantivy index directory |
| `AGENTMEMORY_BLOB_ROOT` | Local blob directory |
| `AGENTMEMORY_DATA_DIR` | Local base directory for runtime data, Tantivy, blobs, and snapshots |
| `AGENTMEMORY_SECRET` | Bearer token used to protect the API and viewer integration |
| `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `GEMINI_API_KEY`, `OPENROUTER_API_KEY`, `MINIMAX_API_KEY` | Optional LLM provider keys |
| `AGENTMEMORY_AUTO_COMPRESS` | Enable LLM compression when a provider is configured |
| `AGENTMEMORY_INJECT_CONTEXT` | Enable hook-driven context injection |
| `CONSOLIDATION_ENABLED` | Enable the consolidation pipeline |
| `GRAPH_EXTRACTION_ENABLED` | Add LLM-generated typed graph relations; deterministic structural graph extraction remains available without a key |

## Operations and Backups

Treat this as a small stateful service, not a disposable CLI cache.

- Keep PostgreSQL, Qdrant, Neo4j, Tantivy, and blobs on persistent storage.
- Back up all five data planes at a consistent point in time.
- Run `node dist/cli.mjs doctor` after changing URLs, credentials, ports, or hooks.
- Monitor `/agentmemory/health`, not only `/agentmemory/livez`. Liveness says the process is reachable; health reports dependency state.
- Keep the REST API on loopback unless it is protected by `AGENTMEMORY_SECRET`, TLS, and an access-controlled proxy.
- Use export before destructive maintenance and test restores in a separate environment.

## Development

```bash
npm run build
npm test
npm run dev
```

The test suite excludes the integration test by default. Run `npm run test:integration` only when the required services are available.

Key implementation locations:

| Path | Responsibility |
|---|---|
| `src/index.ts` | Worker bootstrap and mandatory backend initialization |
| `src/config.ts` | Environment loading and backend configuration |
| `src/state/` | PostgreSQL, Qdrant, Neo4j, Tantivy, and filesystem adapters |
| `src/functions/` | Memory, graph, search, lifecycle, and export functions |
| `src/triggers/api.ts` | REST endpoint registration |
| `src/mcp/` | MCP server and standalone bridge |
| `src/viewer/` | Local dashboard and graph viewer |
| `plugin/` | Agent plugins, hooks, and skills |

## Upstream and License

This fork retains the upstream project's Apache-2.0 license. See [LICENSE](LICENSE).

- Upstream project: [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory)
- Fork repository: [MirahSyakilla/agentmemory](https://github.com/MirahSyakilla/agentmemory)
- Upstream changes can be valuable, but review them against this fork's mandatory external-backend model before merging.
