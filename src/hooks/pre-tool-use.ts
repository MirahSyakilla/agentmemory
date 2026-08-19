#!/usr/bin/env node
import { hookAgentId, resolveProject } from "./_project.js";
import { loadHookEnv } from "./_env.js";
import { recordContextReduction } from "./_context-reduction.js";
import type { ContextReductionAccounting } from "../types.js";

loadHookEnv();

function isSdkChildContext(payload: unknown): boolean {
  if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
  if (!payload || typeof payload !== "object") return false;
  return (payload as { entrypoint?: unknown }).entrypoint === "sdk-ts";
}

// Pre-tool-use enrichment hook.
//
// THIS HOOK IS A NO-OP BY DEFAULT AS OF 0.8.10 (#143). Previously it
// fired /agentmemory/enrich on every Edit/Write/Read/Glob/Grep tool call
// and wrote up to 4000 chars of context to stdout. Supporting hosts add
// that output to model context, which meant agentmemory could silently add
// roughly 1000 estimated tokens to every matching tool turn (#143).
//
// Users who explicitly want pre-tool enrichment opt in with:
//   AGENTMEMORY_INJECT_CONTEXT=true   in ~/.agentmemory/.env
// and restart the host. Expect session input context to grow
// proportionally with the number of file-touching tool calls per turn.
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";

const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";

function authHeaders(): Record<string, string> {
  const h: Record<string, string> = { "Content-Type": "application/json" };
  if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
  return h;
}

async function main() {
  // Default off: exit immediately so we don't even open stdin. This keeps
  // Claude Code's tool-call hot path as cheap as possible.
  if (!INJECT_CONTEXT) return;

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

  const toolName =
    typeof data.tool_name === "string"
      ? data.tool_name
      : typeof data.toolName === "string"
        ? data.toolName
        : undefined;
  if (!toolName) return;

  const normalizedToolName = toolName.toLowerCase();
  const fileTools = [
    "edit",
    "write",
    "create",
    "read",
    "view",
    "glob",
    "grep",
    "apply_patch",
    "view_image",
  ];
  if (!fileTools.includes(normalizedToolName)) return;

  const rawToolInput = data.tool_input ?? data.toolArgs;
  const toolInput =
    typeof rawToolInput === "object" &&
    rawToolInput !== null &&
    !Array.isArray(rawToolInput)
      ? (rawToolInput as Record<string, unknown>)
      : {};
  const files: string[] = [];
  const fileKeys =
    normalizedToolName === "grep"
      ? ["path", "file"]
      : ["file_path", "path", "file", "pattern"];
  for (const key of fileKeys) {
    const val = toolInput[key];
    if (typeof val === "string" && val.length > 0) files.push(val);
  }
  if (normalizedToolName === "view_image") {
    const imagePath = toolInput["path"];
    if (typeof imagePath === "string" && imagePath.length > 0) {
      files.push(imagePath);
    }
  }
  if (normalizedToolName === "apply_patch") {
    const patchText =
      typeof rawToolInput === "string"
        ? rawToolInput
        : typeof toolInput["patch"] === "string"
          ? toolInput["patch"]
          : typeof toolInput["input"] === "string"
            ? toolInput["input"]
            : "";
    for (const match of patchText.matchAll(
      /^\*\*\* (?:Add|Update|Delete) File: (.+)$/gm,
    )) {
      if (match[1]) files.push(match[1].trim());
    }
  }
  const uniqueFiles = [...new Set(files)];
  if (uniqueFiles.length === 0) return;

  const terms: string[] = [];
  if (normalizedToolName === "grep" || normalizedToolName === "glob") {
    const pattern = toolInput["pattern"];
    if (typeof pattern === "string" && pattern.length > 0) {
      terms.push(pattern);
    }
  }

  const rawSessionId = data.session_id || data.sessionId || data.conversation_id;
  const sessionId =
    typeof rawSessionId === "string" && rawSessionId.length > 0
      ? rawSessionId
      : "unknown";
  const project =
    typeof data.project === "string" && data.project.trim().length > 0
      ? data.project.trim()
      : resolveProject(data.cwd as string | undefined);
  const agentId = hookAgentId(data);

  try {
    const res = await fetch(`${REST_URL}/agentmemory/enrich`, {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({
        sessionId,
        files: uniqueFiles,
        terms,
        toolName,
        ...(project !== undefined && { project }),
        ...(agentId ? { agentId } : {}),
      }),
      signal: AbortSignal.timeout(2000),
    });

    if (res.ok) {
      const result = (await res.json()) as {
        context?: string;
        accounting?: ContextReductionAccounting;
      };
      if (result.context) {
        process.stdout.write(result.context);
        await recordContextReduction({
          restUrl: REST_URL,
          secret: SECRET,
          accounting: result.accounting,
          source: "pre_tool_use",
          sessionId,
          project,
        });
      }
    }
  } catch {
    // don't block tool execution
  }
}

main().catch(() => process.exit(0));
