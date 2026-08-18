#!/usr/bin/env node

import "./_env.js";
import { resolveProject, hookCwd } from "./_project.js";

// Inlined — see src/hooks/sdk-guard.ts for canonical version. Kept local
// per-hook so tsdown does not emit a shared hashed chunk that would churn
// the diff on every rebuild.
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  let input = "";
  for await (const chunk of process.stdin) {
    input += chunk;
  }

  let data: Record<string, unknown>;
  try {
    data = JSON.parse(input);
  } catch {
    return;
  }

  if (!data || typeof data !== "object") return;
  if (isSdkChildContext(data)) {
    // Do not summarize from inside a Claude Agent SDK child session;
    // would re-enter agent-sdk provider and loop (see sdk-guard.ts).
    return;
  }

  const sessionId =
    ((data.session_id || data.sessionId || data.conversation_id) as string) ||
    "unknown";
  const cwd = hookCwd(data) || process.cwd();
  const turnId =
    typeof data.turn_id === "string"
      ? data.turn_id
      : typeof data.turnId === "string"
        ? data.turnId
        : undefined;
  const model = typeof data.model === "string" ? data.model : undefined;
  const lastAssistantMessage =
    typeof data.last_assistant_message === "string"
      ? data.last_assistant_message.slice(0, 4000)
      : typeof data.lastAssistantMessage === "string"
        ? data.lastAssistantMessage.slice(0, 4000)
        : undefined;
  const stopHookActive =
    typeof data.stop_hook_active === "boolean"
      ? data.stop_hook_active
      : typeof data.stopHookActive === "boolean"
        ? data.stopHookActive
        : undefined;
  const reason =
    typeof data.reason === "string"
      ? data.reason.slice(0, 1000)
      : typeof data.stop_reason === "string"
        ? data.stop_reason.slice(0, 1000)
        : typeof data.stopReason === "string"
          ? data.stopReason.slice(0, 1000)
          : undefined;

  // Stop is a per-turn checkpoint. The separate session-end hook owns final
  // completion and the upstream stopped-consolidation lifecycle.
  fetch(`${REST_URL}/agentmemory/session/turn-end`, {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      sessionId,
      project: resolveProject(cwd),
      cwd,
      timestamp: new Date().toISOString(),
      ...(turnId ? { turnId } : {}),
      ...(model ? { model } : {}),
      ...(lastAssistantMessage ? { lastAssistantMessage } : {}),
      ...(stopHookActive !== undefined ? { stopHookActive } : {}),
      ...(reason ? { reason } : {}),
    }),
    signal: AbortSignal.timeout(5000),
  }).catch(() => {});

  setTimeout(() => process.exit(0), 1500).unref();
}

main().catch(() => process.exit(0));
