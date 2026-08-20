# AgentMemory External-Backend Fork

Persistent memory for coding agents, built on the [iii engine](https://github.com/iii-hq/iii). It captures agent activity, stores durable observations and decisions, and returns relevant context through MCP, REST, hooks, and the local viewer.

This repository is a maintained fork of [rohitg00/agentmemory](https://github.com/rohitg00/agentmemory), currently based on upstream `v0.9.29`. It keeps the upstream agent integrations and memory model, but deliberately changes the storage and deployment model for persistent multi-service operation.

## What It Does

- Captures prompts, tool use, file work, session milestones, and explicit memory saves.
- Plans task-aware retrieval across lexical, vector, graph, temporal, experiment, artifact, evidence, and negative-memory sources.
- Serves 74 MCP tools. Its full MCP surface is 74 tools, 6 resources, 3 prompts, and 17 skills.
- Exposes 156 endpoints on port `3111`, with the viewer on `127.0.0.1:3113`.
- Supports Claude Code, Codex, OpenCode, Cursor, Copilot CLI, pi, Devin, Droid, Antigravity, and MCP-capable clients.
- Keeps session history, lessons, relations, audit records, graph data, exports, and backups separate from the agent's working repository.

## Latest Benchmark And Verification

The following results were measured against the live deployment after commit
`18f8520`, the controlled Tantivy/Qdrant rebuild, and the PM2 reload on
2026-08-20.

| Check | Result |
|---|---|
| First post-reload `smart-search` request for `React` | `1,604.8` ms cache miss |
| 20 subsequent `smart-search` requests, limit 5, lessons disabled | p50 `60.7` ms, p95 `211.6` ms, mean `73.9` ms, 20/20 successful |
| Project-scoped live search for `agentmemory` | 10/10 results belonged to `agentmemory`; impossible project returned 0 |
| Controlled index rebuild | 19,775 Tantivy entries and 19,775 Qdrant vectors |
| Build | `npm run build` passed |
| Retrieval test suite | 171 files passed, 1 skipped; 1,820 tests passed, 1 skipped |
| Full `npm test` status | 3 isolated `test/fs-watcher.test.ts` failures; retrieval and all other tests passed |

The passing retrieval-focused verification used:

```bash
TMPDIR="/home/meow/.cache/agentmemory-test-tmp" \
PATH="/home/meow/.local/bin:/home/meow/.nvm/versions/node/v26.3.0/bin:$PATH" \
npx vitest run --exclude test/integration.test.ts --exclude test/fs-watcher.test.ts
```

The three excluded filesystem-watcher failures were:

- `emits a post_tool_use observation with HookPayload shape on write`
- `emits changeKind=file_delete when a watched file is removed`
- `attaches Bearer auth when a secret is configured`

The pre-rebuild baseline and provider-latency breakdown are documented in the
[detailed benchmark notes](#neo4j-benchmark) below.

## Planned Retrieval And Evidence

Use `memory_retrieval_plan` or `POST /agentmemory/retrieval/plan` when context needs more than a keyword search. The deterministic planner identifies intent, named entities, temporal constraints, evidence needs, and excluded terms; then combines the available lexical/vector/graph/memory paths with first-class experiments, artifacts, typed evidence, temporal memory, and reusable negative knowledge.

- Every plan accepts `project` and `agentId` scope and reports source coverage, temporal filtering, conflict warnings, negative-memory warnings, and a token ledger.
- Returned context is partitioned into direct, supporting, historical, and provenance tiers. Omitted records get opaque, short-lived expansion handles from `memory_retrieval_expand` or `/agentmemory/retrieval/expand`.
- Evidence records retain provenance, precise locator, linked artifacts/experiments, and verification method, verifier, result, and timestamp. Use `memory_evidence_verify` to persist verification rather than relying on an untracked assertion.
- Experiments connect objective, hypothesis, environment, revision, toolchain, commands, inputs, actions, sessions, artifacts, observations, evidence, result, conclusion, and follow-up links.
- Negative-memory records prevent blind retries of tested-invalid approaches and can be scoped by project, agent, environment, source revision, and validity interval.
- Contradictions are durable conflict records. Resolve them explicitly with evidence and epistemic states; the system retains the conflicting evidence and historical records instead of silently deleting one side.

Durable write idempotency is available for structured evidence, artifact, experiment, and negative-memory creates via `idempotencyKey`, `requestId`, or `fingerprint`. It requires this fork's mandatory PostgreSQL metadata backend; unsupported backends fail rather than emulating an unsafe read-then-write claim.

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

## Graph Search Operations

Smart search keeps graph enrichment enabled by default. Set
`AGENTMEMORY_GRAPH_SEARCH_TIMEOUT_MS` to tune its wall-clock budget; values are
clamped to `100`-`250` ms and default to `200` ms. If Neo4j is slow, unavailable,
or the targeted lookup exceeds the budget, BM25/vector results are returned
without waiting for an unbounded graph scan.

Legacy Neo4j corpora can rebuild the observation-to-node reverse index through
bounded, resumable pages. The operation uses the existing snapshot-rebuild
endpoint but does not run the unsafe full `kv.list` rebuild:

```bash
curl -X POST http://127.0.0.1:3111/agentmemory/graph/snapshot-rebuild \
  -H 'Content-Type: application/json' \
  -d '{"backfill":true,"pageSize":25,"maxPages":10}'
```

Repeat the request until the response contains `"complete":true`; the cursor
is persisted server-side, so a retry resumes safely. `pageSize` is capped at
25 nodes and `maxPages` at 10 per request. Use `{"reset":true}` only to restart
the cursor; existing index rows are merged idempotently.

### Neo4j Benchmark

The corrected targeted path was benchmarked against the live deployment on
2026-08-20. The graph snapshot reported 15,172 nodes and 29,848 edges at the
time of the original end-to-end run.

- Direct `React` entity retrieval with depth-2 neighborhood, 20 warm runs and a 200 ms graph budget: 20/20 completed without timeout; p50 `31.3` ms, p95 `49.0` ms, mean `35.2` ms; all runs returned five results with session IDs resolved.
- The Neo4j reverse-index lookup plan uses `NodeUniqueIndexSeek`, rather than a graph-node label scan.
- End-to-end `POST /agentmemory/smart-search` for `React`, limit 5, 20 warm requests: graph enabled p50 `1,157.4` ms, p95 `1,739.9` ms, mean `1,221.4` ms; graph-disabled control p50 `971.7` ms, p95 `1,529.0` ms, mean `1,056.7` ms.
- The measured graph-enabled median overhead was `185.7` ms. This includes the full BM25, vector, enrichment, and HTTP path, not just Neo4j; the graph leg itself remained inside its 200 ms budget on the targeted benchmark.
- Pre-rebuild live rerun on 2026-08-20: 20 warm sequential `POST /agentmemory/smart-search` requests for `React`, limit 5, with lessons disabled returned p50 `945.6` ms, p95 `1,091.5` ms, mean `962.0` ms, and no HTTP errors.
- The matching provider split over five live samples measured OpenAI query embedding at mean `970.9` ms for 1,024 dimensions and Qdrant search at mean `5.6` ms; combined embedding plus Qdrant mean was `976.5` ms. These are the pre-rebuild baseline numbers for the scope-aware retrieval and query-embedding-cache rollout.

### Scope-Aware Index Rebuild

After the benchmark above, the persisted Tantivy and Qdrant indexes were rebuilt
with the scope metadata required by project- and agent-filtered retrieval. The
controlled maintenance runner is:

```bash
REBUILD_EMBED_BATCH_SIZE=128 \
  node --import tsx scripts/controlled-rebuild.mts
```

Stop the live `agentmemory` worker before running it and start the worker again
only after the command prints its `phase: "complete"` record. The runner checks
that PostgreSQL, Neo4j, Tantivy, and Qdrant are the active backends, clears both
search indexes, rebuilds them from durable metadata, and prints preflight and
postflight counts. The 2026-08-20 rebuild processed `517` sessions, `523,322`
observations, and `876` memories, producing `19,775` Tantivy entries and
`19,775` Qdrant vectors. Three sessions above the `5,000`-observation safety
bound were skipped; the configured `20,000` search-index cap also limits the
rebuild below the full `472,698` eligible-record corpus.

The result supports keeping corrected Neo4j as the current graph backend. FalkorDB is not being treated as a drop-in replacement; it should only be prototyped after an isolated quality and throughput comparison shows Neo4j still misses the operational target.

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
| `AGENTMEMORY_GRAPH_SEARCH_TIMEOUT_MS` | Graph enrichment budget in milliseconds, clamped to `100`-`250`, default `200` |
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
