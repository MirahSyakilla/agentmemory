import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const HOOK_ENV_KEYS = new Set([
  "AGENTMEMORY_URL",
  "AGENTMEMORY_SECRET",
  "AGENTMEMORY_INJECT_CONTEXT",
  "AGENTMEMORY_PROJECT_NAME",
  "AGENT_ID",
  "AGENTMEMORY_AGENT_SCOPE",
  "CLAUDE_MEMORY_BRIDGE",
]);

let hookEnvLoaded = false;

function unquoteEnvValue(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === '"' || quote === "'") && trimmed.endsWith(quote)) {
    return trimmed.slice(1, -1);
  }
  const comment = trimmed.indexOf(" #");
  return comment === -1 ? trimmed : trimmed.slice(0, comment).trim();
}

export function loadHookEnv(): void {
  if (hookEnvLoaded) return;
  hookEnvLoaded = true;
  const envPath =
    process.env["AGENTMEMORY_ENV_FILE"] ||
    join(homedir(), ".agentmemory", ".env");
  if (!existsSync(envPath)) return;

  try {
    for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const separator = trimmed.indexOf("=");
      if (separator < 1) continue;
      const key = trimmed.slice(0, separator).trim();
      if (!HOOK_ENV_KEYS.has(key) || process.env[key] !== undefined) continue;
      process.env[key] = unquoteEnvValue(trimmed.slice(separator + 1));
    }
  } catch {}
}

loadHookEnv();
