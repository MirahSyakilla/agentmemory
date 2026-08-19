import { execSync } from "node:child_process";
import { basename } from "node:path";

// Resolution order: AGENTMEMORY_PROJECT_NAME env → git toplevel basename → cwd basename.
export function resolveProject(cwd?: string): string {
  const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
  if (explicit && explicit.trim()) return explicit.trim();
  const dir = cwd && cwd.trim() ? cwd : process.cwd();
  try {
    const top = execSync("git rev-parse --show-toplevel", {
      cwd: dir,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 500,
    })
      .toString()
      .trim();
    if (top) return basename(top);
  } catch {}
  return basename(dir);
}

export function hookCwd(data: Record<string, unknown> | null | undefined): string | undefined {
  if (!data || typeof data !== "object") return undefined;
  if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
  const roots = data.workspace_roots;
  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root === "string" && root.trim()) return root;
    }
  }
  const projectDir =
    process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
  if (projectDir && projectDir.trim()) return projectDir;
  return undefined;
}

// Hook providers do not agree on agent naming. Prefer an explicit host value
// over the process default so a shared daemon retains subagent attribution.
export function hookAgentId(
  data: Record<string, unknown> | null | undefined,
): string | undefined {
  const values = data
    ? [data.agentId, data.agent_id, data.agentName, data.agent_name]
    : [];
  values.push(process.env["AGENT_ID"]);
  for (const value of values) {
    if (typeof value === "string" && value.trim()) return value.trim().slice(0, 128);
  }
  if (process.env["OPENCODE"] === "1") return "opencode";
  if (process.env["CODEX_THREAD_ID"]) return "codex";
  if (process.env["CLAUDE_PROJECT_DIR"]) return "claude-code";
  return undefined;
}
