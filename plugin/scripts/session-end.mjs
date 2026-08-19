#!/usr/bin/env node
import { existsSync, readFileSync } from "node:fs";
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { homedir } from "node:os";
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
//#region src/hooks/session-end.ts
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
function authHeaders() {
	const h = { "Content-Type": "application/json" };
	if (SECRET) h["Authorization"] = `Bearer ${SECRET}`;
	return h;
}
function extractTranscriptPrompts(data) {
	const path = data.transcript_path;
	if (typeof path !== "string" || !path.endsWith(".jsonl")) return [];
	let raw;
	try {
		raw = readFileSync(path, "utf-8");
	} catch {
		return [];
	}
	const prompts = [];
	for (const line of raw.split("\n")) {
		if (!line.trim()) continue;
		let msg;
		try {
			msg = JSON.parse(line);
		} catch {
			continue;
		}
		if (msg.role !== "user") continue;
		for (const block of msg.message?.content ?? []) {
			if (prompts.length >= 50) return prompts;
			if (block.type !== "text" || typeof block.text !== "string") continue;
			const m = block.text.match(/<user_query>\n?([\s\S]*?)\n?<\/user_query>/);
			const text = (m ? m[1] : block.text).trim();
			if (text) prompts.push(text.slice(0, 8e3));
		}
	}
	return prompts;
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
	const transcriptPrompts = extractTranscriptPrompts(data);
	if (transcriptPrompts.length > 0) {
		const cwd = hookCwd(data) || process.cwd();
		const project = resolveProject(cwd);
		const timestamp = (/* @__PURE__ */ new Date()).toISOString();
		Promise.allSettled(transcriptPrompts.map((prompt) => fetch(`${REST_URL}/agentmemory/observe`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				hookType: "prompt_submit",
				sessionId,
				project,
				cwd,
				timestamp,
				...agentId ? { agentId } : {},
				data: { prompt }
			}),
			signal: AbortSignal.timeout(3e3)
		}))).catch(() => {});
	}
	fetch(`${REST_URL}/agentmemory/session/end`, {
		method: "POST",
		headers: authHeaders(),
		body: JSON.stringify({ sessionId }),
		signal: AbortSignal.timeout(3e4)
	}).catch(() => {});
	if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") fetch(`${REST_URL}/agentmemory/claude-bridge/sync`, {
		method: "POST",
		headers: authHeaders(),
		signal: AbortSignal.timeout(3e4)
	}).catch(() => {});
	setTimeout(() => process.exit(0), 1500).unref();
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=session-end.mjs.map