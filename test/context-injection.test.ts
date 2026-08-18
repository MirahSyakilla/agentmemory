import { afterAll, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const HOOKS_DIR = join(import.meta.dirname, "..", "plugin", "scripts");
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "agentmemory-hook-test-"));

afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

// Spawns a compiled plugin hook as a subprocess, feeds it JSON on stdin,
// and returns { stdout, stderr, exitCode, tookMs }. The test is about
// making sure the hook writes NOTHING to stdout when context injection is
// disabled — supporting hosts treat hook stdout as model-visible context.
function runHook(
  scriptName: string,
  stdin: string,
  env: Record<string, string>,
): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number | null;
  tookMs: number;
}> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const child = spawn(
      process.execPath,
      [join(HOOKS_DIR, scriptName)],
      {
        env: {
          // Start from a clean slate — don't leak test-runner env into
          // the hook. Only pass PATH and anything explicitly set by the
          // test case.
          PATH: process.env["PATH"] ?? "",
          HOME: ISOLATED_HOME,
          ...env,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );

    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    child.on("error", reject);
    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode, tookMs: Date.now() - start });
    });

    child.stdin.write(stdin);
    child.stdin.end();
  });
}

describe("pre-tool-use hook — context injection gate (#143)", () => {
  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset (default)", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    // No AGENTMEMORY_* env vars at all — simulates a fresh host
    // install with no ~/.agentmemory/.env overrides.
    const result = await runHook("pre-tool-use.mjs", payload, {});
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT=false explicitly", async () => {
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Edit",
      tool_input: { file_path: "src/foo.ts", old_string: "a", new_string: "b" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "false",
    });
    expect(result.stdout).toBe("");
    expect(result.exitCode).toBe(0);
  });

  it("exits fast when disabled (no stdin consumption, no network fetch)", async () => {
    // The disabled path must not open stdin or reach for fetch — it
    // should return immediately. A 250ms budget is generous enough to
    // account for Node startup on CI while still catching any accidental
    // fetch round-trip or stdin buffering.
    const result = await runHook("pre-tool-use.mjs", "", {});
    expect(result.tookMs).toBeLessThan(1000);
    expect(result.stdout).toBe("");
  });

  it("when AGENTMEMORY_INJECT_CONTEXT=true, hook still runs but safely errors on unreachable backend", async () => {
    // Opt-in path. We point at a port that's guaranteed closed so the
    // fetch fails fast; the hook must still exit cleanly (the whole
    // point of the try/catch is not to break the host) and must not
    // echo anything to stdout when the fetch fails.
    const payload = JSON.stringify({
      session_id: "ses_test",
      tool_name: "Read",
      tool_input: { file_path: "src/foo.ts" },
    });
    const result = await runHook("pre-tool-use.mjs", payload, {
      AGENTMEMORY_INJECT_CONTEXT: "true",
      AGENTMEMORY_URL: "http://127.0.0.1:1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });
});

describe("session-start hook — context injection gate (#143)", () => {
  it("registers the session but writes nothing to stdout when AGENTMEMORY_INJECT_CONTEXT is unset", async () => {
    // Session registration POST will fail against the unreachable URL,
    // but the hook's try/catch must swallow that cleanly — the host
    // must never see an error at session start.
    const payload = JSON.stringify({
      session_id: "ses_test",
      cwd: "/tmp/fake-project",
    });
    const result = await runHook("session-start.mjs", payload, {
      AGENTMEMORY_URL: "http://127.0.0.1:1",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("");
  });

  it("loads injection settings from ~/.agentmemory/.env and records emitted context", async () => {
    const home = mkdtempSync(join(tmpdir(), "agentmemory-hook-env-"));
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url || "");
      req.resume();
      res.setHeader("content-type", "application/json");
      if (req.url === "/agentmemory/session/start") {
        res.end(JSON.stringify({
          context: "<agentmemory-context>remembered</agentmemory-context>",
          accounting: {
            eventId: "ctxred_hook_test",
            estimator: "chars_div_3_v1",
            baselineTokens: 40,
            returnedTokens: 20,
            tokenDelta: 20,
          },
        }));
        return;
      }
      res.statusCode = 201;
      res.end(JSON.stringify({ success: true }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");
    mkdirSync(join(home, ".agentmemory"), { recursive: true });
    writeFileSync(
      join(home, ".agentmemory", ".env"),
      `AGENTMEMORY_INJECT_CONTEXT=true\nAGENTMEMORY_URL=http://127.0.0.1:${address.port}\n`,
    );

    try {
      const result = await runHook(
        "session-start.mjs",
        JSON.stringify({ session_id: "ses_env", cwd: "/tmp/project-env" }),
        { HOME: home },
      );
      expect(result.stdout).toContain("remembered");
      expect(paths).toContain("/agentmemory/session/start");
      expect(paths).toContain("/agentmemory/context-reduction/events");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      rmSync(home, { recursive: true, force: true });
    }
  });
});

describe("pre-compact hook — context injection gate (#143)", () => {
  it("does not request or emit context when injection is disabled", async () => {
    const paths: string[] = [];
    const server = createServer((req, res) => {
      paths.push(req.url || "");
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ context: "should-not-be-emitted" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");

    try {
      const result = await runHook(
        "pre-compact.mjs",
        JSON.stringify({ session_id: "ses_compact", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "false",
          AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
        },
      );
      expect(result.stdout).toBe("");
      expect(paths).not.toContain("/agentmemory/context");
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("subagent-start hook — telemetry only", () => {
  it("never emits model context even when injection is enabled", async () => {
    const server = createServer((req, res) => {
      req.resume();
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ context: "must-not-be-emitted" }));
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");

    try {
      const result = await runHook(
        "subagent-start.mjs",
        JSON.stringify({
          session_id: "ses_parent",
          agent_id: "agent_child",
          agent_type: "explorer",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${address.port}`,
        },
      );
      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});

describe("stop hook — turn checkpoint", () => {
  it("checkpoints the Codex turn without calling session/end", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const server = createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => {
        body += chunk.toString();
      });
      req.on("end", () => {
        requests.push({
          path: req.url || "",
          body: body ? JSON.parse(body) : {},
        });
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ success: true }));
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("test server unavailable");

    try {
      const result = await runHook(
        "stop.mjs",
        JSON.stringify({
          session_id: "ses_same_thread",
          turn_id: "turn_1",
          cwd: "/tmp/project",
          model: "gpt-test",
          last_assistant_message: "Stopped response",
        }),
        { AGENTMEMORY_URL: `http://127.0.0.1:${address.port}` },
      );

      expect(result.stdout).toBe("");
      expect(result.exitCode).toBe(0);
      expect(requests.map((request) => request.path)).toEqual([
        "/agentmemory/session/turn-end",
      ]);
      expect(requests[0]?.body).toMatchObject({
        sessionId: "ses_same_thread",
        turnId: "turn_1",
        project: "project",
        cwd: "/tmp/project",
        model: "gpt-test",
      });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
