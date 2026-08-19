#!/usr/bin/env bash
# Boot a sandboxed agentmemory + iii-engine on alt ports with a clean data dir,
# so eval runs aren't polluted by (and don't pollute) your real ~/.agentmemory.
# Source it: `source eval/scripts/sandbox.sh` then run eval scripts;
# the sandbox is torn down on EXIT.

set -euo pipefail

SANDBOX_ROOT="${SANDBOX_ROOT:-/tmp/agentmemory-eval-sandbox}"
SANDBOX_PORT="${SANDBOX_PORT:-3411}"
SANDBOX_STREAM_PORT="${SANDBOX_STREAM_PORT:-3412}"
# Engine WS port must match the worker's REST+46023 derivation
# (src/config.ts), and must NOT be the default 49134 when a production
# daemon is running — iii 0.11.3 panics on bind collision.
SANDBOX_ENGINE_PORT="${SANDBOX_ENGINE_PORT:-$((SANDBOX_PORT + 46023))}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"

if ! command -v iii >/dev/null 2>&1; then
  echo "iii binary not on PATH. Install pinned version:"
  echo "  curl -fsSL https://github.com/iii-hq/iii/releases/download/iii/v0.11.3/iii-aarch64-apple-darwin.tar.gz | tar -xz -C ~/.local/bin"
  exit 1
fi

iii_ver=$(iii --version 2>&1 | head -1)
if [[ "$iii_ver" != "0.11.3" ]]; then
  echo "warning: iii version on PATH is $iii_ver; agentmemory pins 0.11.3"
fi

if [[ ! -f "$REPO_ROOT/dist/index.mjs" ]]; then
  echo "dist/ missing. Run: npm run build" >&2
  exit 1
fi

if [[ -z "${SANDBOX_ROOT:-}" || "$SANDBOX_ROOT" == "/" || "$SANDBOX_ROOT" != /tmp/* ]]; then
  echo "refusing to wipe SANDBOX_ROOT='$SANDBOX_ROOT' — must be non-empty and under /tmp/" >&2
  exit 1
fi
rm -rf "$SANDBOX_ROOT"
mkdir -p "$SANDBOX_ROOT/data" "$SANDBOX_ROOT/.agentmemory"

cat > "$SANDBOX_ROOT/iii-config.yaml" <<EOF
workers:
  - name: iii-worker-manager
    config:
      port: $SANDBOX_ENGINE_PORT
      host: 127.0.0.1
  - name: iii-http
    config:
      port: $SANDBOX_PORT
      host: 127.0.0.1
      default_timeout: 180000
      cors:
        allowed_origins: ["http://localhost:$SANDBOX_PORT", "http://127.0.0.1:$SANDBOX_PORT"]
        allowed_methods: [GET, POST, PUT, DELETE, OPTIONS]
  - name: iii-state
    config:
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: $SANDBOX_ROOT/data/state_store.db
  - name: iii-queue
    config:
      adapter:
        name: builtin
  - name: iii-pubsub
    config:
      adapter:
        name: local
  - name: iii-cron
    config:
      adapter:
        name: kv
  - name: iii-stream
    config:
      port: $SANDBOX_STREAM_PORT
      host: 127.0.0.1
      adapter:
        name: kv
        config:
          store_method: file_based
          file_path: $SANDBOX_ROOT/data/stream_store
  - name: iii-observability
    config:
      enabled: false
      service_name: agentmemory-eval
      exporter: memory
      sampling_ratio: 0.0
      metrics_enabled: false
      logs_enabled: false
      logs_console_output: false
  - name: iii-exec
    config:
      exec:
        - node $REPO_ROOT/dist/index.mjs
EOF

cd "$SANDBOX_ROOT"
# Backend isolation: without these the sandbox worker inherits the
# defaults from src/config.ts and writes eval rows into the
# PRODUCTION Postgres database, Qdrant collection, and tantivy index.
# Postgres: dedicated agentmemory_eval database (dropped + recreated).
# Qdrant: dedicated *_eval collection. Tantivy/blobs: sandbox data dir
# via HOME redirection. Neo4j is isolated when the server supports a
# dedicated database; Community edition warns before retaining the
# default database because remember/smart-search do not write graph scopes.
if ! command -v psql >/dev/null 2>&1; then
  echo "psql is required to provision the isolated agentmemory_eval database" >&2
  exit 1
fi
if ! PGPASSWORD="${AGENTMEMORY_PG_PASSWORD:-agentmemory}" psql \
    -h "${AGENTMEMORY_PG_HOST:-127.0.0.1}" \
    -p "${AGENTMEMORY_PG_PORT:-5432}" \
    -U "${AGENTMEMORY_PG_USER:-agentmemory}" \
    -d postgres -v ON_ERROR_STOP=1 \
    -c "DROP DATABASE IF EXISTS agentmemory_eval WITH (FORCE);" >/dev/null 2>&1; then
  echo "failed to reset isolated agentmemory_eval database" >&2
  exit 1
fi
if ! PGPASSWORD="${AGENTMEMORY_PG_PASSWORD:-agentmemory}" psql \
    -h "${AGENTMEMORY_PG_HOST:-127.0.0.1}" \
    -p "${AGENTMEMORY_PG_PORT:-5432}" \
    -U "${AGENTMEMORY_PG_USER:-agentmemory}" \
    -d postgres -v ON_ERROR_STOP=1 \
    -c "CREATE DATABASE agentmemory_eval;" >/dev/null 2>&1; then
  echo "failed to create isolated agentmemory_eval database" >&2
  exit 1
fi

# Qdrant: drop the eval collection so each run starts empty; the
# worker recreates it on first vector write.
QDRANT_URL="${AGENTMEMORY_QDRANT_URL:-http://127.0.0.1:6333}"
curl -sS --max-time 2 -X DELETE "$QDRANT_URL/collections/agentmemory_vectors_eval" >/dev/null 2>&1 || true

# Neo4j: dedicated database so graph writes never touch production.
# Community edition rejects CREATE DATABASE — fall back to sharing the
# default database with a warning (the remember/smart-search eval
# paths don't write graph scopes, so the risk is limited to boot-time
# constraint creation, which is idempotent).
SANDBOX_NEO4J_DATABASE=""
NEO4J_HTTP="${AGENTMEMORY_NEO4J_HTTP:-http://127.0.0.1:7474}"
NEO4J_CREDS="${AGENTMEMORY_NEO4J_USER:-neo4j}:${AGENTMEMORY_NEO4J_PASSWORD:-agentmemory}"
if curl -sS --max-time 2 -u "$NEO4J_CREDS" "$NEO4J_HTTP/" >/dev/null 2>&1; then
  if curl -sS -u "$NEO4J_CREDS" -H 'Content-Type: application/json' \
      "$NEO4J_HTTP/db/system/tx" \
      -d '{"statements":[{"statement":"SHOW DATABASE agentmemory_eval YIELD name"}]}' 2>/dev/null \
      | grep -q '"name":"agentmemory_eval"'; then
    SANDBOX_NEO4J_DATABASE="agentmemory_eval"
  else
    if curl -sS -u "$NEO4J_CREDS" -H 'Content-Type: application/json' \
        "$NEO4J_HTTP/db/system/tx" \
        -d '{"statements":[{"statement":"CREATE DATABASE agentmemory_eval"}]}' >/dev/null 2>&1 \
        && curl -sS -u "$NEO4J_CREDS" -H 'Content-Type: application/json' \
        "$NEO4J_HTTP/db/system/tx" \
        -d '{"statements":[{"statement":"SHOW DATABASE agentmemory_eval YIELD name"}]}' 2>/dev/null \
        | grep -q '"name":"agentmemory_eval"'; then
      SANDBOX_NEO4J_DATABASE="agentmemory_eval"
    else
      echo "warning: Neo4j has no agentmemory_eval database (Community edition?) — eval shares the default database" >&2
    fi
  fi
fi

# III_REST_PORT drives the worker's engineUrl derivation (src/config.ts);
# III_ENGINE_PORT pins it to the iii-worker-manager port above.
HOME="$SANDBOX_ROOT" \
  III_REST_PORT="$SANDBOX_PORT" \
  III_STREAM_PORT="$SANDBOX_STREAM_PORT" \
  III_ENGINE_PORT="$SANDBOX_ENGINE_PORT" \
  AGENTMEMORY_PG_DATABASE=agentmemory_eval \
  AGENTMEMORY_QDRANT_COLLECTION=agentmemory_vectors_eval \
  ${SANDBOX_NEO4J_DATABASE:+AGENTMEMORY_NEO4J_DATABASE="$SANDBOX_NEO4J_DATABASE"} \
  iii --config "$SANDBOX_ROOT/iii-config.yaml" > "$SANDBOX_ROOT/iii.log" 2>&1 &
SANDBOX_PID=$!

cleanup() {
  echo "tearing down sandbox (pid $SANDBOX_PID)"
  kill "$SANDBOX_PID" 2>/dev/null || true
  sleep 1
  kill -9 "$SANDBOX_PID" 2>/dev/null || true
}
trap cleanup EXIT

# wait for livez
for i in $(seq 1 30); do
  if curl -sS --max-time 1 "http://localhost:$SANDBOX_PORT/agentmemory/livez" 2>/dev/null | grep -q '"status":"ok"'; then
    export AGENTMEMORY_BASE_URL="http://localhost:$SANDBOX_PORT"
    cd "$REPO_ROOT"
    echo "sandbox ready: $AGENTMEMORY_BASE_URL"
    echo "  state: $SANDBOX_ROOT/data/"
    echo "  logs:  $SANDBOX_ROOT/iii.log"
    return 0 2>/dev/null || exit 0
  fi
  sleep 1
done

echo "sandbox failed to come up within 30s. last log lines:" >&2
tail -10 "$SANDBOX_ROOT/iii.log" >&2
exit 1
