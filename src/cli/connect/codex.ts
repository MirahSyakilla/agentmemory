import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, dirname, resolve } from "node:path";
import * as p from "@clack/prompts";
import type { ConnectAdapter, ConnectOptions, ConnectResult } from "./types.js";
import {
  backupFile,
  logAlreadyWired,
  logBackup,
  logInstalled,
  readJsonSafe,
  writeJsonAtomic,
} from "./util.js";
import {
  buildMergedHooks,
  findPluginRoot,
  type HookManifest,
} from "./codex-hooks.js";

const CODEX_DIR = join(homedir(), ".codex");
const CODEX_TOML = join(CODEX_DIR, "config.toml");
const CODEX_HOOKS = join(CODEX_DIR, "hooks.json");

const SECTION_HEADER = "[mcp_servers.agentmemory]";
const ENV_SECTION_HEADER = "[mcp_servers.agentmemory.env]";

function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isWiredText(toml: string): boolean {
  return toml.includes(SECTION_HEADER);
}

function sectionBounds(
  lines: string[],
  header: string,
): { start: number; end: number } | null {
  const start = lines.findIndex((line) => line.trim() === header);
  if (start === -1) return null;
  let end = start + 1;
  while (end < lines.length && !lines[end].trim().startsWith("[")) end += 1;
  return { start, end };
}

function replaceManagedSectionLines(
  lines: string[],
  header: string,
  managedKeys: string[],
  managedLines: string[],
): string[] {
  const bounds = sectionBounds(lines, header);
  if (!bounds) return lines;
  const preserved = lines
    .slice(bounds.start + 1, bounds.end)
    .filter((line) => {
      const trimmed = line.trim();
      return !managedKeys.some((key) =>
        new RegExp(`^${key}\\s*=`).test(trimmed),
      );
    });
  while (preserved[0]?.trim() === "") preserved.shift();
  const replacement = [header, ...managedLines];
  if (preserved.length > 0) replacement.push(...preserved);
  replacement.push("");
  return [
    ...lines.slice(0, bounds.start),
    ...replacement,
    ...lines.slice(bounds.end),
  ];
}

function insertSection(
  lines: string[],
  index: number,
  header: string,
  managedLines: string[],
): string[] {
  const prefix = lines.slice(0, index);
  while (prefix.at(-1)?.trim() === "") prefix.pop();
  if (prefix.length > 0) prefix.push("");
  return [
    ...prefix,
    header,
    ...managedLines,
    "",
    ...lines.slice(index),
  ];
}

export function mergeCodexMcpToml(
  toml: string,
  standalonePath = resolve(
    join(findPluginRoot(), "..", "dist", "standalone.mjs"),
  ),
): string {
  const baseLines = [
    'command = "node"',
    `args = [${tomlString(standalonePath)}]`,
  ];
  const envLines = [
    'AGENTMEMORY_URL = "http://localhost:3111"',
    'AGENTMEMORY_TOOLS = "all"',
  ];
  let lines = toml.split(/\r?\n/);

  if (sectionBounds(lines, SECTION_HEADER)) {
    lines = replaceManagedSectionLines(
      lines,
      SECTION_HEADER,
      ["command", "args"],
      baseLines,
    );
  } else {
    const childIndex = lines.findIndex((line) =>
      line.trim().startsWith("[mcp_servers.agentmemory."),
    );
    lines = insertSection(
      lines,
      childIndex === -1 ? lines.length : childIndex,
      SECTION_HEADER,
      baseLines,
    );
  }

  if (sectionBounds(lines, ENV_SECTION_HEADER)) {
    lines = replaceManagedSectionLines(
      lines,
      ENV_SECTION_HEADER,
      ["AGENTMEMORY_URL", "AGENTMEMORY_TOOLS"],
      envLines,
    );
  } else {
    const baseBounds = sectionBounds(lines, SECTION_HEADER);
    lines = insertSection(
      lines,
      baseBounds?.end ?? lines.length,
      ENV_SECTION_HEADER,
      envLines,
    );
  }

  return `${lines.join("\n").trimEnd()}\n`;
}

export const adapter: ConnectAdapter = {
  name: "codex",
  displayName: "Codex CLI",
  category: "native",
  docs: "https://github.com/rohitg00/agentmemory#codex-cli-codex-plugin-platform",
  protocolNote:
    "→ Using MCP. Hooks ship via the Codex plugin; on Codex Desktop, also pass --with-hooks to install the global hooks.json workaround for openai/codex#16430.",

  detect(): boolean {
    return existsSync(CODEX_DIR);
  },

  async install(opts: ConnectOptions): Promise<ConnectResult> {
    const exists = existsSync(CODEX_TOML);
    const current = exists ? readFileSync(CODEX_TOML, "utf-8") : "";
    const wired = isWiredText(current);

    if (wired && !opts.force) {
      logAlreadyWired("Codex CLI", CODEX_TOML);
      return { kind: "already-wired", mutatedPath: CODEX_TOML };
    }

    if (opts.dryRun) {
      p.log.info(
        `[dry-run] Would ${wired ? "rewrite" : "append"} [mcp_servers.agentmemory] in ${CODEX_TOML}`,
      );
      if (opts.withHooks) installCodexHooks(opts);
      return { kind: "installed", mutatedPath: CODEX_TOML };
    }

    let backupPath: string | undefined;
    if (exists) {
      backupPath = backupFile(CODEX_TOML, "codex", "toml");
      logBackup(backupPath);
    } else {
      mkdirSync(dirname(CODEX_TOML), { recursive: true });
    }

    const next = mergeCodexMcpToml(current);
    writeFileSync(CODEX_TOML, next, "utf-8");

    const verify = readFileSync(CODEX_TOML, "utf-8");
    if (!isWiredText(verify)) {
      p.log.error(
        `Verification failed: ${CODEX_TOML} did not contain ${SECTION_HEADER} after write.`,
      );
      return { kind: "skipped", reason: "verification-failed" };
    }

    logInstalled("Codex CLI", CODEX_TOML);
    p.log.info(
      "Codex picks up MCP servers on next launch. For the deeper plugin install, run: codex plugin marketplace add rohitg00/agentmemory && codex plugin add agentmemory@agentmemory",
    );

    if (opts.withHooks) {
      const hookResult = installCodexHooks(opts);
      if (hookResult.kind === "skipped") {
        p.log.warn(
          `Codex hooks fallback skipped: ${hookResult.reason}. MCP wiring still applied.`,
        );
      }
    }

    return {
      kind: "installed",
      mutatedPath: CODEX_TOML,
      ...(backupPath !== undefined && { backupPath }),
    };
  },
};

/**
 * Install the global `~/.codex/hooks.json` fallback. See
 * `codex-hooks.ts` for context (openai/codex#16430). Returns a result
 * describing the side effect for the caller's summary; failures here do
 * not roll back the MCP wiring.
 */
function installCodexHooks(opts: ConnectOptions): ConnectResult {
  let pluginRoot: string;
  try {
    pluginRoot = findPluginRoot();
  } catch (err) {
    return {
      kind: "skipped",
      reason: err instanceof Error ? err.message : String(err),
    };
  }

  const existing = readJsonSafe<HookManifest>(CODEX_HOOKS);
  const merged = buildMergedHooks(existing, pluginRoot);

  if (opts.dryRun) {
    p.log.info(
      `[dry-run] Would ${existing ? "merge" : "create"} ${CODEX_HOOKS} with ${Object.keys(merged.hooks).length} event(s)`,
    );
    return { kind: "installed", mutatedPath: CODEX_HOOKS };
  }

  let backupPath: string | undefined;
  if (existsSync(CODEX_HOOKS)) {
    backupPath = backupFile(CODEX_HOOKS, "codex-hooks", "json");
    logBackup(backupPath);
  }

  writeJsonAtomic(CODEX_HOOKS, merged);

  logInstalled("Codex hooks (workaround for openai/codex#16430)", CODEX_HOOKS);
  p.log.warn(
    "Codex runs only trusted hooks: launch `codex` (the TUI) once and choose \"Trust all and continue\" at the \"Hooks need review\" prompt. `codex exec` never shows the prompt, so hooks stay inert until then.",
  );
  p.log.info(
    "User-scope hooks reference absolute paths under the bundled plugin/ dir. Re-run `agentmemory connect codex --with-hooks` after upgrading agentmemory to refresh them, then re-approve in the TUI.",
  );

  return {
    kind: "installed",
    mutatedPath: CODEX_HOOKS,
    ...(backupPath !== undefined && { backupPath }),
  };
}
