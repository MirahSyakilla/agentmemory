import type {
  RawObservation,
  CompressedObservation,
  ObservationType,
} from "../types.js";

// Zero-LLM compression path. Converts a RawObservation into a
// CompressedObservation using only heuristics — no Claude call, no token
// spend. This is the default as of 0.8.8 (#138); users who want richer
// LLM-generated summaries set AGENTMEMORY_AUTO_COMPRESS=true.

function inferType(
  toolName: string | undefined,
  hookType: string,
): ObservationType {
  if (hookType === "post_tool_failure") return "error";
  if (hookType === "prompt_submit") return "conversation";
  if (hookType === "subagent_stop" || hookType === "task_completed")
    return "subagent";
  if (hookType === "notification") return "notification";

  if (!toolName) return "other";
  // Normalize camelCase and kebab-case into word chunks so we can match
  // substrings like "WebFetch" -> "web" / "fetch".
  const n = toolName
    .replace(/([a-z])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
  const hasWord = (word: string) =>
    new RegExp(`(^|_)${word}(_|$)`).test(n) ||
    n === word ||
    n.endsWith(word) ||
    n.startsWith(word);
  if (["fetch", "http", "web"].some(hasWord)) return "web_fetch";
  if (["grep", "search", "glob", "find"].some(hasWord)) return "search";
  if (["bash", "shell", "exec", "run"].some(hasWord)) return "command_run";
  if (["edit", "update", "patch", "replace"].some(hasWord)) return "file_edit";
  if (["write", "create"].some(hasWord)) return "file_write";
  if (["read", "view"].some(hasWord)) return "file_read";
  if (["task", "agent"].some(hasWord)) return "subagent";
  return "other";
}

function extractFiles(input: unknown): string[] {
  const out = new Set<string>();

  function addCandidate(value: string): void {
    const trimmed = value.trim().replace(/[),.;:'"`\]}]+$/g, "");
    if (
      trimmed.length > 0 &&
      trimmed.length < 512 &&
      !trimmed.startsWith("http") &&
      !trimmed.startsWith("data:")
    ) {
      out.add(trimmed);
    }
  }

  function scanString(value: string): void {
    const patchRe = /^\*\*\* (?:Update|Add|Delete) File: (.+)$/gm;
    let patchMatch: RegExpExecArray | null;
    while ((patchMatch = patchRe.exec(value)) !== null) {
      addCandidate(patchMatch[1]);
    }

    const pathRe =
      /(?:^|[\s"'`(=:{])((?:\.{1,2}\/|\/)[A-Za-z0-9_@%+=:,./-]{1,240}|[A-Za-z0-9_@%+=:.-]+(?:\/[A-Za-z0-9_@%+=:.-]+)+\.[A-Za-z0-9]{1,12})(?=$|[\s"'`),};\]])/g;
    let match: RegExpExecArray | null;
    while ((match = pathRe.exec(value)) !== null) {
      addCandidate(match[1]);
    }
  }

  function visit(value: unknown, depth: number): void {
    if (depth > 3 || value == null) return;
    if (typeof value === "string") {
      scanString(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value.slice(0, 50)) visit(item, depth + 1);
      return;
    }
    if (typeof value !== "object") return;

    const o = value as Record<string, unknown>;
    for (const key of [
      "file_path",
      "filepath",
      "path",
      "filePath",
      "file",
      "pattern",
      "cmd",
      "command",
      "workdir",
    ]) {
      const v = o[key];
      if (typeof v === "string") {
        if (
          [
            "file_path",
            "filepath",
            "path",
            "filePath",
            "file",
            "pattern",
            "workdir",
          ].includes(key)
        ) {
          addCandidate(v);
        }
        scanString(v);
      }
    }
    for (const value of Object.values(o).slice(0, 50)) {
      visit(value, depth + 1);
    }
  }

  visit(input, 0);
  return [...out];
}

const STOP_CONCEPTS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "your",
  "you",
  "are",
  "was",
  "were",
  "have",
  "has",
  "had",
  "will",
  "would",
  "could",
  "should",
  "into",
  "then",
  "than",
  "there",
  "here",
  "function",
  "command",
  "output",
  "input",
  "call",
  "tool",
  "json",
  "true",
  "false",
  "null",
]);

function extractConcepts(text: string, files: string[]): string[] {
  const out = new Set<string>();
  const add = (token: string) => {
    const t = token.toLowerCase().replace(/^[-_.]+|[-_.]+$/g, "");
    if (
      t.length >= 3 &&
      t.length <= 32 &&
      !STOP_CONCEPTS.has(t) &&
      !/^\d+$/.test(t) &&
      !/^[a-f0-9]{16,}$/i.test(t)
    ) {
      out.add(t);
    }
  };

  for (const file of files.slice(0, 20)) {
    for (const part of file.split(/[\\/_.-]+/)) add(part);
  }

  for (const token of text.split(/[^A-Za-z0-9_+-]+/)) {
    add(token);
    if (out.size >= 16) break;
  }

  return [...out].slice(0, 16);
}

function stringifyForNarrative(v: unknown): string {
  if (v == null) return "";
  if (typeof v === "string") return v;
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "\u2026" : s;
}

export function buildSyntheticCompression(
  raw: RawObservation,
): CompressedObservation {
  const toolName = raw.toolName ?? raw.hookType;
  const inputStr = stringifyForNarrative(raw.toolInput);
  const outputStr = stringifyForNarrative(raw.toolOutput);
  const promptStr = raw.userPrompt ?? "";

  const narrativeParts = [promptStr, inputStr, outputStr].filter(
    (s) => s.length > 0,
  );
  const files = [
    ...new Set([
      ...extractFiles(raw.toolInput),
      ...extractFiles(raw.toolOutput),
      ...extractFiles(raw.raw),
    ]),
  ].slice(0, 40);
  const type = inferType(toolName, raw.hookType);

  const result: CompressedObservation = {
    id: raw.id,
    sessionId: raw.sessionId,
    timestamp: raw.timestamp,
    type,
    title: truncate(toolName || "observation", 80),
    subtitle: inputStr ? truncate(inputStr, 120) : undefined,
    facts: [],
    narrative: truncate(narrativeParts.join(" | "), 400),
    concepts: extractConcepts(
      [toolName, promptStr, inputStr, outputStr].filter(Boolean).join(" "),
      files,
    ),
    files,
    importance: type === "error" ? 8 : type === "file_edit" || type === "file_write" ? 7 : 5,
    confidence: 0.3,
  };
  if (raw.modality) result.modality = raw.modality;
  if (raw.imageData) result.imageData = raw.imageData;
  if (raw.agentId) result.agentId = raw.agentId;
  return result;
}
