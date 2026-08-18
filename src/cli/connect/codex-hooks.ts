import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Shared merge engine for writing agentmemory's bundled hook scripts into
 * a host's global, user-scope hooks config. Originally built as a
 * workaround for openai/codex#16430 — Codex Desktop does not dispatch
 * plugin-local `hooks.json` even though both `CodexHooks` and `PluginHooks`
 * feature flags are stable + default-enabled in
 * `codex-rs/features/src/lib.rs`. Until upstream fixes plugin-scope
 * dispatch, the same hook commands can be mirrored into the global
 * `~/.codex/hooks.json`, which is loaded reliably.
 *
 * The same merge logic now also backs Claude Code's `--with-hooks`
 * fallback (`~/.claude/settings.json`, #508 workaround) and Droid's
 * native `~/.factory/hooks.json` install, since both hosts consume the
 * identical `{ hooks: { <event>: [{ matcher?, hooks: [{ type, command }] }] } }`
 * shape — only the bundled manifest file passed to `buildMergedHooks`
 * differs per host.
 *
 * This module builds that merge, with `${CLAUDE_PLUGIN_ROOT}` resolved to
 * the bundled `plugin/` directory so the user-scope file does not depend
 * on env-var expansion (only Claude Code actually injects
 * `CLAUDE_PLUGIN_ROOT` for plugin-scope hooks — the token is reused here
 * purely as an internal placeholder for "the bundled plugin/ dir").
 *
 * Identification on re-install: every command we write contains the
 * resolved `<pluginRoot>/scripts/` prefix, so subsequent installs can
 * strip our entries and re-add cleanly without touching the user's other
 * hook entries.
 */

type HookHandler = { type: string; command: string };
type HookEntry = { matcher?: string; hooks: HookHandler[] };
export type HookManifest = { hooks: Record<string, HookEntry[]> };

/**
 * Locate the bundled `plugin/` directory at runtime. Walks up from the
 * module's own location looking for `plugin/scripts/` + `plugin/hooks/`,
 * both shipped via the npm `files` field. Works for both `dist/cli.mjs`
 * (bundled) and `src/cli/connect/codex-hooks.ts` (dev) layouts.
 */
export function findPluginRoot(startUrl: string = import.meta.url): string {
  const here = dirname(fileURLToPath(startUrl));
  let dir = here;
  for (let i = 0; i < 12; i++) {
    if (
      existsSync(join(dir, "plugin", "scripts")) &&
      existsSync(join(dir, "plugin", "hooks"))
    ) {
      return resolve(join(dir, "plugin"));
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  throw new Error(
    `agentmemory: could not locate bundled plugin/ directory (searched up from ${here})`,
  );
}

/**
 * Build the merged hooks.json content.
 *
 *   1. Strip any entry from `existing` whose first hook command points
 *      under `<pluginRoot>/scripts/`. This lets us re-install idempotently
 *      without leaving stale references.
 *   2. Append fresh entries from the bundled Codex manifest with
 *      `${CLAUDE_PLUGIN_ROOT}` rewritten to the absolute plugin path.
 *      Matcher values from the bundled manifest are preserved so PreToolUse
 *      event routing keeps working.
 */
export function buildMergedHooks(
  existing: HookManifest | null,
  pluginRoot: string,
  manifestFile = "hooks.codex.json",
): HookManifest {
  const bundledManifestPath = join(pluginRoot, "hooks", manifestFile);
  const ours = JSON.parse(readFileSync(bundledManifestPath, "utf-8")) as HookManifest;
  const scriptsDir = join(pluginRoot, "scripts");
  const knownScriptNames = new Set<string>();
  for (const entries of Object.values(ours.hooks)) {
    for (const entry of entries) {
      for (const handler of entry.hooks) {
        const resolved = handler.command.replace(
          /\$\{CLAUDE_PLUGIN_ROOT\}/g,
          pluginRoot,
        );
        knownScriptNames.add(
          basename(normalizePathForCommandMatch(resolved)).toLowerCase(),
        );
      }
    }
  }

  const out: HookManifest = { hooks: {} };

  if (existing?.hooks) {
    for (const [event, entries] of Object.entries(existing.hooks)) {
      const kept = entries.filter(
        (entry) => !isAgentmemoryEntry(entry, scriptsDir, knownScriptNames),
      );
      if (kept.length > 0) out.hooks[event] = kept;
    }
  }

  for (const [event, entries] of Object.entries(ours.hooks)) {
    const resolvedEntries: HookEntry[] = entries.map((entry) => {
      const next: HookEntry = {
        hooks: entry.hooks.map((handler) => ({
          type: handler.type,
          command: handler.command.replace(/\$\{CLAUDE_PLUGIN_ROOT\}/g, pluginRoot),
        })),
      };
      if (entry.matcher !== undefined) next.matcher = entry.matcher;
      return next;
    });
    out.hooks[event] = [...(out.hooks[event] ?? []), ...resolvedEntries];
  }

  return out;
}

function isAgentmemoryEntry(
  entry: HookEntry,
  scriptsDir: string,
  knownScriptNames: Set<string>,
): boolean {
  const normalizedScriptsDir = normalizePathForCommandMatch(scriptsDir).toLowerCase();
  return entry.hooks.some((handler) => {
    const normalized = normalizePathForCommandMatch(handler.command).toLowerCase();
    if (normalized.includes(normalizedScriptsDir)) return true;
    if (!normalized.includes("agentmemory")) return false;
    if (!normalized.includes("/plugin/scripts/")) return false;
    return Array.from(knownScriptNames).some((scriptName) =>
      normalized.includes(`/plugin/scripts/${scriptName}`),
    );
  });
}

function normalizePathForCommandMatch(value: string): string {
  return value.replace(/\\/g, "/");
}
