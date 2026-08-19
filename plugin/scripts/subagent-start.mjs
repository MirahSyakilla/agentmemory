#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { execSync } from "node:child_process";
//#region src/hooks/_env.ts
const HOOK_ENV_KEYS = new Set([
	"AGENTMEMORY_URL",
	"AGENTMEMORY_SECRET",
	"AGENTMEMORY_INJECT_CONTEXT",
	"AGENTMEMORY_PROJECT_NAME",
	"AGENT_ID",
	"AGENTMEMORY_AGENT_SCOPE",
	"CLAUDE_MEMORY_BRIDGE"
]);
let hookEnvLoaded = false;
function unquoteEnvValue(value) {
	const trimmed = value.trim();
	const quote = trimmed[0];
	if ((quote === "\"" || quote === "'") && trimmed.endsWith(quote)) return trimmed.slice(1, -1);
	const comment = trimmed.indexOf(" #");
	return comment === -1 ? trimmed : trimmed.slice(0, comment).trim();
}
function loadHookEnv() {
	if (hookEnvLoaded) return;
	hookEnvLoaded = true;
	const envPath = process.env["AGENTMEMORY_ENV_FILE"] || join(homedir(), ".agentmemory", ".env");
	if (!existsSync(envPath)) return;
	try {
		for (const line of readFileSync(envPath, "utf-8").split(/\r?\n/)) {
			const trimmed = line.trim();
			if (!trimmed || trimmed.startsWith("#")) continue;
			const separator = trimmed.indexOf("=");
			if (separator < 1) continue;
			const key = trimmed.slice(0, separator).trim();
			if (!HOOK_ENV_KEYS.has(key) || process.env[key] !== void 0) continue;
			process.env[key] = unquoteEnvValue(trimmed.slice(separator + 1));
		}
	} catch {}
}
loadHookEnv();
//#endregion
//#region src/hooks/_project.ts
function resolveProject(cwd) {
	const explicit = process.env["AGENTMEMORY_PROJECT_NAME"];
	if (explicit && explicit.trim()) return explicit.trim();
	const dir = cwd && cwd.trim() ? cwd : process.cwd();
	try {
		const top = execSync("git rev-parse --show-toplevel", {
			cwd: dir,
			stdio: [
				"ignore",
				"pipe",
				"ignore"
			],
			timeout: 500
		}).toString().trim();
		if (top) return basename(top);
	} catch {}
	return basename(dir);
}
function hookCwd(data) {
	if (!data || typeof data !== "object") return void 0;
	if (typeof data.cwd === "string" && data.cwd.trim()) return data.cwd;
	const roots = data.workspace_roots;
	if (Array.isArray(roots)) {
		for (const root of roots) if (typeof root === "string" && root.trim()) return root;
	}
	const projectDir = process.env["DEVIN_PROJECT_DIR"] || process.env["CLAUDE_PROJECT_DIR"];
	if (projectDir && projectDir.trim()) return projectDir;
}
function hookAgentId(data) {
	const values = data ? [
		data.agentId,
		data.agent_id,
		data.agentName,
		data.agent_name
	] : [];
	values.push(process.env["AGENT_ID"]);
	for (const value of values) if (typeof value === "string" && value.trim()) return value.trim().slice(0, 128);
	if (process.env["OPENCODE"] === "1") return "opencode";
	if (process.env["CODEX_THREAD_ID"]) return "codex";
	if (process.env["CLAUDE_PROJECT_DIR"]) return "claude-code";
}
//#endregion
//#region src/hooks/subagent-start.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const TIMEOUT_MS = 800;
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
async function main() {
	let input = "";
	for await (const chunk of process.stdin) input += chunk;
	let data;
	try {
		data = JSON.parse(input);
	} catch {
		return;
	}
	if (!data || typeof data !== "object") return;
	if (isSdkChildContext(data)) return;
	const sessionId = data.session_id || data.sessionId || data.conversation_id || "unknown";
	const agentId = hookAgentId(data);
	const agentType = data.agent_type || data.agentDisplayName || data.agentName;
	const cwd = hookCwd(data) || process.cwd();
	fetch(`${REST_URL}/agentmemory/observe`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({
			hookType: "subagent_start",
			sessionId,
			project: resolveProject(cwd),
			cwd,
			timestamp: (/* @__PURE__ */ new Date()).toISOString(),
			...agentId ? { agentId } : {},
			data: {
				agent_id: agentId,
				agent_type: agentType
			}
		}),
		signal: AbortSignal.timeout(TIMEOUT_MS)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=subagent-start.mjs.map