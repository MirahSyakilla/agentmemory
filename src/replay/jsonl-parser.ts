import type { HookType, RawObservation } from "../types.js";
import { generateId } from "../state/schema.js";

interface JsonlEntry {
  type?: string;
  uuid?: string;
  sessionId?: string;
  timestamp?: string;
  cwd?: string;
  message?: {
    role?: string;
    content?: unknown;
  };
  payload?: Record<string, unknown>;
  toolUseResult?: unknown;
  [k: string]: unknown;
}

export interface ParsedTranscript {
  sessionId: string;
  project: string;
  cwd: string;
  startedAt: string;
  endedAt: string;
  observations: RawObservation[];
  source?: "claude" | "codex";
}

function deriveProject(cwd: string): string {
  if (!cwd) return "unknown";
  const parts = cwd.split("/").filter(Boolean);
  return parts[parts.length - 1] || "unknown";
}

function toText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const parts: string[] = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (
      (entry.type === "text" ||
        entry.type === "input_text" ||
        entry.type === "output_text") &&
      typeof entry.text === "string"
    ) {
      parts.push(entry.text);
    }
  }
  return parts.join("\n");
}

function extractToolUses(content: unknown): Array<{ id: string; name: string; input: unknown }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ id: string; name: string; input: unknown }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_use") {
      out.push({
        id: typeof entry.id === "string" ? entry.id : "",
        name: typeof entry.name === "string" ? entry.name : "unknown",
        input: entry.input,
      });
    }
  }
  return out;
}

function extractToolResults(content: unknown): Array<{ toolUseId: string; output: unknown; isError: boolean }> {
  if (!Array.isArray(content)) return [];
  const out: Array<{ toolUseId: string; output: unknown; isError: boolean }> = [];
  for (const item of content) {
    if (!item || typeof item !== "object") continue;
    const entry = item as Record<string, unknown>;
    if (entry.type === "tool_result") {
      out.push({
        toolUseId: typeof entry.tool_use_id === "string" ? entry.tool_use_id : "",
        output: entry.content,
        isError: entry.is_error === true,
      });
    }
  }
  return out;
}

function stableObsId(sessionId: string, index: number): string {
  return `${sessionId}-obs-${String(index).padStart(6, "0")}`;
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function parseJsonMaybe(value: unknown): unknown {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function pushObservation(
  observations: RawObservation[],
  sessionId: string,
  timestamp: string,
  obs: Omit<RawObservation, "id" | "sessionId" | "timestamp">,
): void {
  observations.push({
    id: stableObsId(sessionId, observations.length + 1),
    sessionId,
    timestamp,
    ...obs,
  });
}

function isCodexEntry(entry: JsonlEntry): boolean {
  return (
    entry.type === "session_meta" ||
    entry.type === "event_msg" ||
    entry.type === "response_item" ||
    entry.type === "turn_context" ||
    entry.type === "compacted"
  );
}

function isUserFacingPrompt(text: string): boolean {
  return !(
    text.startsWith("# AGENTS.md instructions") ||
    text.startsWith("<environment_context>") ||
    text.startsWith("<permissions instructions>") ||
    text.startsWith("<collaboration_mode>")
  );
}

function parseCodexEntries(entries: JsonlEntry[], fallbackSessionId?: string): ParsedTranscript {
  const firstMeta = entries.find((e) => e.type === "session_meta" && e.payload);
  const meta = firstMeta?.payload ?? {};
  const sessionId =
    stringOrUndefined(meta["id"]) ||
    stringOrUndefined((meta["payload"] as Record<string, unknown> | undefined)?.["id"]) ||
    fallbackSessionId ||
    generateId("sess");
  const cwd = stringOrUndefined(meta["cwd"]) || "";
  const observations: RawObservation[] = [];
  const toolNamesByCallId = new Map<string, string>();
  const hasAgentMessages = entries.some(
    (e) => e.type === "event_msg" && e.payload?.["type"] === "agent_message",
  );
  let firstTs = stringOrUndefined(meta["timestamp"]) || firstMeta?.timestamp || "";
  let lastTs = firstTs;

  if (firstMeta) {
    pushObservation(observations, sessionId, firstMeta.timestamp || firstTs || new Date().toISOString(), {
      hookType: "session_start" as HookType,
      raw: firstMeta,
    });
  }

  for (const entry of entries) {
    const ts = entry.timestamp || firstTs || new Date().toISOString();
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    const payload = entry.payload || {};
    if (entry.type === "event_msg") {
      const payloadType = payload["type"];
      if (payloadType === "user_message") {
        const message = stringOrUndefined(payload["message"]);
        if (message && isUserFacingPrompt(message)) {
          pushObservation(observations, sessionId, ts, {
            hookType: "prompt_submit" as HookType,
            userPrompt: message,
            raw: entry,
          });
        }
      } else if (payloadType === "agent_message") {
        const message = stringOrUndefined(payload["message"]);
        if (message) {
          pushObservation(observations, sessionId, ts, {
            hookType: "stop" as HookType,
            assistantResponse: message,
            raw: entry,
          });
        }
      } else if (payloadType === "error") {
        pushObservation(observations, sessionId, ts, {
          hookType: "post_tool_failure" as HookType,
          toolName: "codex_error",
          toolOutput: payload["message"] || payload["error"] || payload,
          raw: entry,
        });
      }
      continue;
    }

    if (entry.type !== "response_item") continue;

    const itemType = payload["type"];
    if (itemType === "message") {
      const role = payload["role"];
      const phase = payload["phase"];
      const text = toText(payload["content"]);
      if (!text.trim()) continue;
      if (role === "assistant" && phase === "final_answer" && !hasAgentMessages) {
        pushObservation(observations, sessionId, ts, {
          hookType: "stop" as HookType,
          assistantResponse: text,
          raw: entry,
        });
      }
      continue;
    }

    if (
      itemType === "function_call" ||
      itemType === "custom_tool_call" ||
      itemType === "web_search_call" ||
      itemType === "tool_search_call"
    ) {
      const callId = stringOrUndefined(payload["call_id"]) || stringOrUndefined(payload["id"]) || "";
      const toolName =
        stringOrUndefined(payload["name"]) ||
        (itemType === "web_search_call" ? "web_search" : undefined) ||
        (itemType === "tool_search_call" ? "tool_search" : undefined) ||
        String(itemType);
      if (callId) toolNamesByCallId.set(callId, toolName);
      const input =
        payload["arguments"] !== undefined
          ? parseJsonMaybe(payload["arguments"])
          : payload["input"] !== undefined
            ? parseJsonMaybe(payload["input"])
            : payload;
      pushObservation(observations, sessionId, ts, {
        hookType: "pre_tool_use" as HookType,
        toolName,
        toolInput: input,
        raw: entry,
      });
      continue;
    }

    if (
      itemType === "function_call_output" ||
      itemType === "custom_tool_call_output" ||
      itemType === "tool_search_output"
    ) {
      const callId = stringOrUndefined(payload["call_id"]) || "";
      const toolName =
        (callId && toolNamesByCallId.get(callId)) ||
        (itemType === "tool_search_output" ? "tool_search" : "tool");
      const output = payload["output"] !== undefined ? parseJsonMaybe(payload["output"]) : payload;
      const status = stringOrUndefined(payload["status"]);
      pushObservation(observations, sessionId, ts, {
        hookType: status === "failed" ? ("post_tool_failure" as HookType) : ("post_tool_use" as HookType),
        toolName,
        toolInput: callId ? { toolUseId: callId } : undefined,
        toolOutput: output,
        raw: entry,
      });
    }
  }

  const nowIso = new Date().toISOString();
  return {
    sessionId,
    project: deriveProject(cwd),
    cwd: cwd || process.cwd(),
    startedAt: firstTs || nowIso,
    endedAt: lastTs || firstTs || nowIso,
    observations,
    source: "codex",
  };
}

export function parseJsonlText(text: string, fallbackSessionId?: string): ParsedTranscript {
  const lines = text.split("\n").filter((l) => l.trim().length > 0);
  const entries: JsonlEntry[] = [];
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed === "object") entries.push(parsed as JsonlEntry);
    } catch {
      // skip malformed lines
    }
  }

  if (entries.some(isCodexEntry)) {
    return parseCodexEntries(entries, fallbackSessionId);
  }

  let sessionId = "";
  let cwd = "";
  let firstTs = "";
  let lastTs = "";

  const observations: RawObservation[] = [];

  for (const entry of entries) {
    if (entry.sessionId && !sessionId) sessionId = entry.sessionId;
    if (entry.cwd && !cwd) cwd = entry.cwd;
    const ts = entry.timestamp || new Date().toISOString();
    if (!firstTs) firstTs = ts;
    lastTs = ts;

    const role = entry.message?.role;
    const content = entry.message?.content;

    if (entry.type === "user" && role === "user") {
      const toolResults = extractToolResults(content);
      if (toolResults.length > 0) {
        for (const result of toolResults) {
          observations.push({
            id: generateId("obs"),
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: (result.isError ? "post_tool_failure" : "post_tool_use") as HookType,
            toolName: undefined,
            toolInput: { toolUseId: result.toolUseId },
            toolOutput: result.output,
            raw: entry,
          });
        }
      } else {
        const text = toText(content);
        if (text.trim().length > 0) {
          observations.push({
            id: generateId("obs"),
            sessionId: sessionId || "imported",
            timestamp: ts,
            hookType: "prompt_submit" as HookType,
            userPrompt: text,
            raw: entry,
          });
        }
      }
    } else if (entry.type === "assistant" && role === "assistant") {
      const text = toText(content);
      const tools = extractToolUses(content);
      if (text.trim().length > 0) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "stop" as HookType,
          assistantResponse: text,
          raw: entry,
        });
      }
      for (const tool of tools) {
        observations.push({
          id: generateId("obs"),
          sessionId: sessionId || "imported",
          timestamp: ts,
          hookType: "pre_tool_use" as HookType,
          toolName: tool.name,
          toolInput: tool.input,
          raw: { toolUseId: tool.id, entry },
        });
      }
    } else if (entry.type === "summary" || entry.type === "system") {
      // ignore meta entries
    }
  }

  const effectiveSessionId = sessionId || fallbackSessionId || generateId("sess");
  for (const obs of observations) {
    if (obs.sessionId === "imported") obs.sessionId = effectiveSessionId;
  }

  const nowIso = new Date().toISOString();
  return {
    sessionId: effectiveSessionId,
    project: deriveProject(cwd),
    cwd: cwd || process.cwd(),
    startedAt: firstTs || nowIso,
    endedAt: lastTs || nowIso,
    observations,
    source: "claude",
  };
}
