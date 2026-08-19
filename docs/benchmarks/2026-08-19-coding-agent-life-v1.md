# 2026-08-19 — coding-agent-life-v1 (v0.9.29)

**Bench:** coding-agent-life-v1 (15 sessions, 15 queries)
**N:** 15
**K:** 5
**Hardware:** WSL2 Ubuntu-22.04 (x86_64), Node v26.3.0
**agentmemory:** v0.9.29
**iii-engine:** v0.11.3
**Embedding provider:** OpenAI-compatible proxy (`text-embedding-v4`, 1024 dims) for the vector adapter; sandbox worker ran zero-LLM (BM25 + hybrid lexical)
**Sandbox:** isolated backends — dedicated Postgres database `agentmemory_eval`, Qdrant collection `agentmemory_vectors_eval`, sandboxed tantivy/blobs via `HOME` override, ports 3411/3412/49434

## Headline

`agentmemory-hybrid` hits **100% top-5 hit rate**, R@5 = **1.000**,
P@5 = **0.240** (at the math ceiling — see the 2026-05-20 scorecard
for the derivation). It is the only adapter that retrieves every gold
session in top-5 for all question types.

| Adapter | P@5 | R@5 | Hit rate | p50 latency |
|---|---|---|---|---|
| grep (tokenized substring) | 0.227 | 0.967 | 15 / 15 | 0 ms |
| vector (OpenAI embeddings + cosine) | 0.227 | 0.967 | 15 / 15 | 1356 ms |
| `agentmemory-hybrid` | **0.240** | **1.000** | **15 / 15** | 18 ms |

## Per-question-type

| Type | grep R@5 | vector R@5 | hybrid R@5 |
|---|---|---|---|
| single-session-* (9 questions) | 1.00 | 1.00 | 1.00 |
| multi-session-causal (2 gold) | 1.00 | 0.50 | **1.00** |
| preference (n=2) | 1.00 | 1.00 | 1.00 |
| multi-session-review (2 gold) | 1.00 | 1.00 | 1.00 |
| temporal (2 gold) | 0.50 | 1.00 | **1.00** |

Differentiators: grep misses one gold session on the temporal question
(`What was shipped on April 8th 2026?`); pure vector misses one gold
session on multi-session-causal (`Which PR fixed the race condition
Aria reported?`). Hybrid retrieves both in every case.

## Fixes landed alongside this run

1. **Sandbox engine port panic** — iii 0.11.3 binds an internal worker
   WebSocket listener on the default 49134 and panics on collision
   when a production daemon is running. `sandbox.sh` now emits an
   explicit `iii-worker-manager` worker pinned to
   `SANDBOX_PORT + 46023` (matching the worker's engineUrl derivation
   in `src/config.ts`) and exports `III_REST_PORT` /
   `III_STREAM_PORT` / `III_ENGINE_PORT` for the worker process.
2. **Backend isolation** — the sandbox worker previously inherited
   the production Postgres database and Qdrant collection defaults
   from `src/config.ts`, writing eval rows into real stores. The
   script now drops + recreates the `agentmemory_eval` Postgres
   database and the `agentmemory_vectors_eval` Qdrant collection per
   run, and uses a dedicated Neo4j database when the server supports
   it (Community edition falls back to the shared database with a
   warning).
3. **agentmemory adapter session mapping** — smart-search returns
   `sessionId: "memory"` for memory-bucket hits, which short-
   circuited the adapter's obsId→session map and zeroed every score.
   The adapter now treats its own ingestion map as authoritative.
4. **vector adapter endpoint flexibility** — honors `OPENAI_BASE_URL`,
   `OPENAI_EMBEDDING_MODEL`, and `OPENAI_EMBEDDING_DIMENSIONS` so
   OpenAI-compatible proxies work.

## Methodology

- 15 fictional Claude Code sessions across a 10-day stretch of a Rust
  CLI project (`shipctl`) — bug fixes, refactors, infra, perf, schema
  migrations, preferences, post-mortem
- 15 hand-graded queries with `goldSessionIds[]`
- Each session ingested via `POST /agentmemory/remember` with
  `type=eval-session` and `concepts=[session_id]`
- Each query hits `POST /agentmemory/smart-search` with `limit=50`;
  dedupe by session ID; truncate to K=5
- No LLM in the retrieval loop
- Production-store cleanliness verified before and after the run
  (eval-window rows in the production Postgres database: 0)

## Reproduce

```sh
npm install --legacy-peer-deps
npm run build

source eval/scripts/sandbox.sh
OPENAI_EMBEDDING_API_KEY=sk-... \
OPENAI_EMBEDDING_MODEL=text-embedding-v4 \
OPENAI_EMBEDDING_DIMENSIONS=1024 \
OPENAI_BASE_URL=https://your-proxy \
  npm run eval:coding-life -- --adapters grep,vector,agentmemory
```

Outputs land in `eval/reports/coding-life/`: `scores.ndjson`
(per-query rows) and `summary.json` (per-adapter and per-type
aggregates).
