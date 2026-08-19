# agentmemory-evals

Public benchmarks for agentmemory's hybrid memory stack (BM25 + embeddings + consolidation + graph).

Two families, both reproducible:

- **LongMemEval** — public 500-question retrieval benchmark over multi-session chat
- **coding-agent-life-v1** — in-house corpus of 15 fictional Claude Code sessions for a Rust CLI project (`shipctl`), with 15 hand-graded queries covering bug fixes, refactors, preferences, and multi-session causal reasoning

## Adapters

| Adapter | Backend | API key needed |
|---|---|---|
| `grep` | Tokenized substring match | none |
| `vector` | OpenAI embeddings + cosine (honors `OPENAI_BASE_URL`, `OPENAI_EMBEDDING_MODEL`, `OPENAI_EMBEDDING_DIMENSIONS`) | `OPENAI_EMBEDDING_API_KEY` |
| `agentmemory` | Running agentmemory server, smart-search endpoint | none (auth optional via `AGENTMEMORY_SECRET`) |

## Sandbox first

Running the `agentmemory` adapter against your real `~/.agentmemory` directory pollutes the eval with pre-existing memories AND pollutes your real store with eval test data. Always sandbox.

`eval/scripts/sandbox.sh` spins up a clean agentmemory + iii-engine on ports 3411/3412 (engine WS on 3411+46023) with state in `/tmp/agentmemory-eval-sandbox/`, exports `AGENTMEMORY_BASE_URL`, and tears down on exit. Backends are isolated from production:

- Postgres: dedicated `agentmemory_eval` database, dropped + recreated per run (requires `psql` on PATH with the same credentials the worker uses)
- Qdrant: dedicated `agentmemory_vectors_eval` collection, deleted per run
- Tantivy/blobs: under the sandbox data dir via `HOME` override
- Neo4j: dedicated `agentmemory_eval` database when the server supports it; on Community edition the script warns and shares the default database (the remember/smart-search eval paths don't write graph scopes)

If the script cannot provision the isolated Postgres database, it fails before starting the worker.

```sh
source eval/scripts/sandbox.sh
npm run eval:coding-life -- --adapters grep,agentmemory
```

Requires iii v0.11.3 on PATH (agentmemory pin). If you already have a different version installed, install the pinned build into `~/.local/bin` and make sure that directory comes first on `PATH`:

```sh
mkdir -p ~/.local/bin
curl -fsSL https://github.com/iii-hq/iii/releases/download/iii/v0.11.3/iii-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.local/bin
export PATH="$HOME/.local/bin:$PATH"  # add to ~/.zshrc or ~/.bashrc for persistence
```

## Quickstart

### coding-agent-life-v1 (in-house, no download)

```sh
# grep baseline, no sandbox needed
npm run eval:coding-life -- --adapters grep

# add agentmemory + vector (sandbox + OpenAI key)
source eval/scripts/sandbox.sh
OPENAI_EMBEDDING_API_KEY=sk-... npm run eval:coding-life -- --adapters grep,vector,agentmemory
```

### LongMemEval `_s` (public, 278MB download)

```sh
mkdir -p ~/LongMemEval
curl --fail --location --continue-at - --output ~/LongMemEval/longmemeval_s.json \
  https://huggingface.co/datasets/xiaowu0162/longmemeval/resolve/main/longmemeval_s

source eval/scripts/sandbox.sh

# Stratified sample of 10 per type (fast iteration, ~$0.20 OpenAI cost)
OPENAI_EMBEDDING_API_KEY=sk-... LONGMEMEVAL_PATH=~/LongMemEval/longmemeval_s.json \
  npm run eval:longmemeval -- --stratify 10 --out ~/LongMemEval/reports/longmemeval-stratify10

# Full 500 questions × 3 adapters (~$2 OpenAI cost)
OPENAI_EMBEDDING_API_KEY=sk-... LONGMEMEVAL_PATH=~/LongMemEval/longmemeval_s.json \
  npm run eval:longmemeval -- --out ~/LongMemEval/reports/longmemeval-full
```

## Repo layout

```text
eval/
├── README.md
├── runner/
│   ├── types.ts                   Adapter, Question, RankedDoc, ScoreRow
│   ├── score.ts                   P@K, R@K, aggregation
│   ├── historical-fixtures.ts     Offline mixed-entity fixture evaluator
│   ├── load.ts                    LongMemEval JSON → Question[]
│   ├── adapters/
│   │   ├── grep.ts                tokenized substring baseline
│   │   ├── vector.ts              OpenAI embeddings + cosine
│   │   └── agentmemory.ts         POST /agentmemory/{remember,smart-search}
│   ├── longmemeval.ts             public benchmark runner
│   └── coding-life.ts             in-house benchmark runner
└── data/
    └── coding-agent-life-v1/
        ├── sessions.json          15 fictional sessions (~6KB)
        └── queries.json           15 queries with gold session IDs
```

Reports land in `eval/reports/<bench>/` (gitignored): `scores.ndjson` + `summary.json`.

Published scorecards land in `docs/benchmarks/YYYY-MM-DD-<bench>.md`.

## Historical task fixtures

`eval/runner/historical-fixtures.ts` is a dependency-free, offline evaluator for
fixed historical tasks. It keeps production memory types and APIs out of the
benchmark contract so a strategy can return a single ranked list containing
`memory`, `experiment`, `artifact`, and `evidence` IDs.

Each fixture has an `id`, `query`, optional `expectedMemoryIds`,
`expectedExperimentIds`, `expectedArtifactIds`, and `expectedEvidenceIds`, plus
optional `scenario` metadata. `scenario.conflict`, `scenario.negative`, and
`scenario.temporal` produce their own aggregate rows when set to `true`.

Strategies are named `retrieve(fixture, k)` functions that return ranked items,
their measured `latencyMs`, and optionally `contextTokens`. The evaluator does
no I/O, does not time strategy execution itself, and never makes network calls;
this makes a fixture run reproducible when strategies supply deterministic
results. If a strategy omits `contextTokens`, they are summed from the first
`k` unique results using an item's explicit `contextTokens` or the transparent
`ceil(context.length / 4)` estimate.

```ts
import {
  evaluateHistoricalTaskFixtures,
  formatHistoricalStrategyReport,
} from "./runner/historical-fixtures.js";

const report = await evaluateHistoricalTaskFixtures(
  [
    {
      id: "release-incident",
      query: "Which evidence resolved the incident?",
      expectedMemoryIds: ["mem_fix"],
      expectedEvidenceIds: ["evidence_logs"],
      scenario: { conflict: true, temporal: true },
    },
  ],
  [
    {
      name: "hybrid",
      retrieve: () => ({
        latencyMs: 4.2,
        items: [
          { id: "evidence_logs", kind: "evidence", contextTokens: 80 },
          { id: "mem_fix", kind: "memory", contextTokens: 120 },
        ],
      }),
    },
  ],
  { k: 5 },
);

console.log(formatHistoricalStrategyReport(report));
```

The returned structured report includes per-fixture Recall@K, Precision@K,
MRR, NDCG@K, latency, and context tokens; per-strategy averages and latency
P50; conflict/negative/temporal subsets; and deltas against a named baseline.
With no `baselineStrategy`, the lexicographically first strategy name is the
baseline. Negative fixtures with no expected IDs retain zero retrieval scores
and separately report `negativeCorrectRate`, which is `1` only when the top-K
result set is empty.

## Writing a new adapter

1. Implement `Adapter<State>` from `eval/runner/types.ts`:
   ```ts
   import type { Adapter } from "../types.js";
   export const myAdapter: Adapter<MyState> = {
     name: "my-adapter",
     async init(sessions, config) { /* index */ return state; },
     async query(q, state, k) { /* search */ return ranked; },
   };
   ```
2. Register in `eval/runner/{longmemeval,coding-life}.ts` `ADAPTERS` map.
3. Run against `coding-agent-life-v1` to sanity-check before committing OpenAI spend on LongMemEval.

## Why a benchmark for agentmemory

agentmemory ships BM25 + embeddings + consolidation + graph retrieval. Numbers from those layers should be measured against grep/vector baselines so the value of each layer is provable.

The in-house corpus is small on purpose (15 sessions) — covers single-session, multi-session, preference, and temporal question types without taking 15 minutes to run. LongMemEval gives the public-comparison axis.
