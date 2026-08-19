#!/usr/bin/env node
import { resolveProject, hookAgentId, hookCwd } from "./_project.js";
import { loadHookEnv } from "./_env.js";
import { recordContextReduction } from "./_context-reduction.js";
import type { ContextReductionAccounting } from "../types.js";

loadHookEnv();

// Inlined from ./sdk-guard so each hook bundles to a single self-contained
// .mjs (matches the pattern used by every other hook entry in tsdown.config).
function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

// Session-start hook.
//
// Always registers the session for observation tracking (so memories
// captured on PostToolUse get attached to the right session). Only writes
// project context to stdout for a supporting host to add to the new thread
// when AGENTMEMORY_INJECT_CONTEXT=true. Default off as of 0.8.10 (#143);
// see pre-tool-use.ts for the full explanation.
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

// When the server is unreachable a 5s timeout multiplies hard under
// concurrent fan-out (Slack bots, multi-agent harnesses) and becomes a
// positive feedback loop that OOM-kills iii-engine (#221). Cap tight on
// both paths and skip the await entirely when the response is unused.
const INJECT_TIMEOUT_MS = 1500;
const REGISTER_TIMEOUT_MS = 800;

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

function contextPayload(data: Record<string, unknown>, context: string): string {
  if (
    typeof data.cursor_version === "string" ||
    data.hook_event_name === "sessionStart"
  ) {
    return JSON.stringify({ additional_context: context });
  }
  if (process.env["DEVIN_PROJECT_DIR"] || data.prompt_id !== undefined) {
    return JSON.stringify({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: context,
      },
    });
  }
  return context;
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
  if (isSdkChildContext(data)) return;

  const sessionId =
    ((data.session_id || data.sessionId || data.conversation_id) as string) ||
    `ses_${Date.now().toString(36)}`;
  const cwd = hookCwd(data) || process.cwd();
  const project = resolveProject(cwd);
  const agentId = hookAgentId(data);
  const title =
    typeof data.prompt === "string"
      ? data.prompt
      : typeof data.userPrompt === "string"
        ? data.userPrompt
        : typeof data.user_prompt === "string"
          ? data.user_prompt
          : undefined;

  const url = `${REST_URL}/agentmemory/session/start`;
  const init: RequestInit = {
    method: "POST",
    headers: authHeaders(),
    body: JSON.stringify({
      sessionId,
      project,
      cwd,
      ...(agentId ? { agentId } : {}),
      ...(title ? { title } : {}),
    }),
  };

  if (!INJECT_CONTEXT) {
    // Pure telemetry path: caller never reads the response, so don't
    // block on it. AbortSignal.timeout caps the wait the event loop
    // gives the pending socket before exit.
    fetch(url, {
      ...init,
      signal: AbortSignal.timeout(REGISTER_TIMEOUT_MS),
    }).catch(() => {});
    setTimeout(() => process.exit(0), 500).unref();
    return;
  }

  try {
    const res = await fetch(url, {
      ...init,
      signal: AbortSignal.timeout(INJECT_TIMEOUT_MS),
    });
    if (res.ok) {
      const result = (await res.json()) as {
        context?: string;
        accounting?: ContextReductionAccounting;
      };
      if (result.context) {
        process.stdout.write(contextPayload(data, result.context));
      }
      await recordContextReduction({
        restUrl: REST_URL,
        secret: SECRET,
        accounting: result.accounting,
        source: "session_start",
        sessionId,
        project,
      });
    }
  } catch {
    // silently fail -- don't block host startup
  }
}

main().catch(() => process.exit(0));
