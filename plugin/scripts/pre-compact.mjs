#!/usr/bin/env node
import { execSync } from "node:child_process";
import { basename, join } from "node:path";
import { existsSync, readFileSync } from "node:fs";
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
//#endregion
//#region src/hooks/_env.ts
const HOOK_ENV_KEYS = new Set([
	"AGENTMEMORY_URL",
	"AGENTMEMORY_SECRET",
	"AGENTMEMORY_INJECT_CONTEXT",
	"AGENTMEMORY_PROJECT_NAME",
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
//#region src/hooks/_context-reduction.ts
async function recordContextReduction(input) {
	if (!input.accounting) return;
	const headers = { "Content-Type": "application/json" };
	if (input.secret) headers["Authorization"] = `Bearer ${input.secret}`;
	try {
		await fetch(`${input.restUrl}/agentmemory/context-reduction/events`, {
			method: "POST",
			headers,
			body: JSON.stringify({
				accounting: input.accounting,
				source: input.source,
				...input.sessionId ? { sessionId: input.sessionId } : {},
				...input.project ? { project: input.project } : {}
			}),
			signal: AbortSignal.timeout(800)
		});
	} catch {}
}
//#endregion
//#region src/hooks/pre-compact.ts
loadHookEnv();
function isSdkChildContext(payload) {
	if (process.env["AGENTMEMORY_SDK_CHILD"] === "1") return true;
	if (!payload || typeof payload !== "object") return false;
	return payload.entrypoint === "sdk-ts";
}
const REST_URL = process.env["AGENTMEMORY_URL"] || "http://localhost:3111";
const SECRET = process.env["AGENTMEMORY_SECRET"] || "";
const INJECT_CONTEXT = process.env["AGENTMEMORY_INJECT_CONTEXT"] === "true";
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
	const project = resolveProject(hookCwd(data));
	if (process.env["CLAUDE_MEMORY_BRIDGE"] === "true") try {
		await fetch(`${REST_URL}/agentmemory/claude-bridge/sync`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({}),
			signal: AbortSignal.timeout(5e3)
		});
	} catch {}
	if (!INJECT_CONTEXT) return;
	try {
		const res = await fetch(`${REST_URL}/agentmemory/context`, {
			method: "POST",
			headers: authHeaders(),
			body: JSON.stringify({
				sessionId,
				project,
				budget: 1500
			}),
			signal: AbortSignal.timeout(5e3)
		});
		if (res.ok) {
			const result = await res.json();
			if (result.context) process.stdout.write(result.context);
			await recordContextReduction({
				restUrl: REST_URL,
				secret: SECRET,
				accounting: result.accounting,
				source: "pre_compact",
				sessionId,
				project
			});
		}
	} catch {}
}
main().catch(() => process.exit(0));
//#endregion
export {};

//# sourceMappingURL=pre-compact.mjs.map