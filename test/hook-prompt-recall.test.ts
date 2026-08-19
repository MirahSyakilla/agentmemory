import { afterAll, describe, it, expect } from "vitest";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { createServer } from "node:http";

const HOOKS_DIR = join(import.meta.dirname, "..", "plugin", "scripts");
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), "agentmemory-hook-recall-"));

afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

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

function startServer(): Promise<{
  server: ReturnType<typeof createServer>;
  port: number;
  paths: string[];
  bodies: Record<string, unknown>[];
  respond: (handler: (path: string) => Record<string, unknown>) => void;
}> {
  const paths: string[] = [];
  const bodies: Record<string, unknown>[] = [];
  let handler: ((path: string) => Record<string, unknown>) | null = null;
  const server = createServer((req, res) => {
    paths.push(req.url || "");
    let body = "";
    req.on("data", (chunk) => { body += chunk.toString(); });
    req.on("end", () => {
      if (body) bodies.push(JSON.parse(body));
      res.setHeader("content-type", "application/json");
      const response = handler ? handler(req.url || "") : { success: true };
      res.end(JSON.stringify(response || { success: true }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("test server unavailable");
      resolve({
        server,
        port: address.port,
        paths,
        bodies,
        respond: (h) => { handler = h; },
      });
    });
  });
}

describe("prompt-aware recall across host hooks", () => {
  it("session-start hook forwards agentId and title to /session/start", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({
      context: "<agentmemory-context>recalled for plan</agentmemory-context>",
      accounting: { eventId: "evt_1", estimator: "chars_div_3_v1", baselineTokens: 10, returnedTokens: 5, tokenDelta: 5 },
    }));

    try {
      const result = await runHook(
        "session-start.mjs",
        JSON.stringify({
          session_id: "ses_prompt_recall",
          cwd: "/tmp/project",
          prompt: "Investigate the kernel boot regression on device X",
          agent_id: "codex",
        }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        },
      );

      expect(result.exitCode).toBe(0);
      const startBody = bodies.find((b) => paths.includes(`/agentmemory/session/start`) && b.sessionId === "ses_prompt_recall");
      expect(startBody).toBeTruthy();
      expect(startBody?.agentId).toBe("codex");
      expect(startBody?.title).toBe("Investigate the kernel boot regression on device X");
      expect(startBody?.project).toBeTruthy();
      expect(result.stdout).toContain("recalled for plan");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("session-start hook omits agentId when host provides none", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ context: "" }));

    try {
      const result = await runHook(
        "session-start.mjs",
        JSON.stringify({ session_id: "ses_no_agent", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        },
      );
      expect(result.exitCode).toBe(0);
      const startBody = bodies.find((b) => paths.includes(`/agentmemory/session/start`) && b.sessionId === "ses_no_agent");
      expect(startBody).toBeTruthy();
      expect(startBody?.agentId).toBeUndefined();
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("session-start hook defaults agentId to 'opencode' when OPENCODE=1", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ context: "" }));

    try {
      const result = await runHook(
        "session-start.mjs",
        JSON.stringify({ session_id: "ses_oc_auto", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );
      expect(result.exitCode).toBe(0);
      const startBody = bodies.find((b) => paths.includes(`/agentmemory/session/start`) && b.sessionId === "ses_oc_auto");
      expect(startBody).toBeTruthy();
      expect(startBody?.agentId).toBe("opencode");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("session-start hook defaults agentId to 'codex' when CODEX_THREAD_ID is set", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ context: "" }));

    try {
      const result = await runHook(
        "session-start.mjs",
        JSON.stringify({ session_id: "ses_cx_auto", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          CODEX_THREAD_ID: "thread_abc",
        },
      );
      expect(result.exitCode).toBe(0);
      const startBody = bodies.find((b) => paths.includes(`/agentmemory/session/start`) && b.sessionId === "ses_cx_auto");
      expect(startBody).toBeTruthy();
      expect(startBody?.agentId).toBe("codex");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("session-start hook prefers explicit agentId over host default", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ context: "" }));

    try {
      const result = await runHook(
        "session-start.mjs",
        JSON.stringify({ session_id: "ses_override", cwd: "/tmp/project", agentId: "custom-agent" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );
      expect(result.exitCode).toBe(0);
      const startBody = bodies.find((b) => paths.includes(`/agentmemory/session/start`) && b.sessionId === "ses_override");
      expect(startBody).toBeTruthy();
      expect(startBody?.agentId).toBe("custom-agent");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pre-compact hook forwards agentId in /agentmemory/context call", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ context: "<agentmemory-context>compact recall</agentmemory-context>" }));

    try {
      const result = await runHook(
        "pre-compact.mjs",
        JSON.stringify({ session_id: "ses_compact", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      expect(result.exitCode).toBe(0);
      const contextBody = bodies.find((b) => paths.includes(`/agentmemory/context`) && b.sessionId === "ses_compact");
      expect(contextBody).toBeTruthy();
      expect(contextBody?.agentId).toBe("opencode");
      expect(contextBody?.project).toBe("project");
      expect(contextBody?.budget).toBe(1500);
      expect(result.stdout).toContain("compact recall");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pre-compact hook does not call /context when injection is disabled", async () => {
    const { server, port, paths, respond } = await startServer();
    respond(() => ({ context: "should-not-be-emitted" }));

    try {
      const result = await runHook(
        "pre-compact.mjs",
        JSON.stringify({ session_id: "ses_compact_off", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "false",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        },
      );

      expect(result.exitCode).toBe(0);
      expect(result.stdout).toBe("");
      expect(paths).not.toContain("/agentmemory/context");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("pre-tool-use hook forwards agentId in /agentmemory/enrich call", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ context: "<agentmemory-context>enriched</agentmemory-context>" }));

    try {
      const result = await runHook(
        "pre-tool-use.mjs",
        JSON.stringify({
          session_id: "ses_tool",
          tool_name: "Read",
          tool_input: { file_path: "src/foo.ts" },
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_INJECT_CONTEXT: "true",
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      expect(result.exitCode).toBe(0);
      const enrichBody = bodies.find((b) => paths.includes(`/agentmemory/enrich`));
      expect(enrichBody).toBeTruthy();
      expect(enrichBody?.agentId).toBe("opencode");
      expect(enrichBody?.files).toEqual(["src/foo.ts"]);
      expect(result.stdout).toContain("enriched");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("prompt-submit hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "prompt-submit.mjs",
        JSON.stringify({ session_id: "ses_prompt", prompt: "fix the build", cwd: "/tmp/project" }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("opencode");
      expect(observeBody?.hookType).toBe("prompt_submit");
      expect(observeBody?.data?.prompt).toBe("fix the build");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("subagent-start hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "subagent-start.mjs",
        JSON.stringify({
          session_id: "ses_parent",
          agent_id: "agent_child",
          agent_type: "explorer",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("agent_child");
      expect(observeBody?.hookType).toBe("subagent_start");
      expect(observeBody?.data?.agent_id).toBe("agent_child");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("subagent-stop hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "subagent-stop.mjs",
        JSON.stringify({
          session_id: "ses_parent",
          agent_id: "agent_child",
          agent_type: "explorer",
          last_assistant_message: "fix applied",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("agent_child");
      expect(observeBody?.hookType).toBe("subagent_stop");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("post-tool-use hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "post-tool-use.mjs",
        JSON.stringify({
          session_id: "ses_tool",
          tool_name: "Edit",
          tool_input: { file_path: "src/foo.ts" },
          tool_output: "edited",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("opencode");
      expect(observeBody?.hookType).toBe("post_tool_use");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("post-tool-failure hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "post-tool-failure.mjs",
        JSON.stringify({
          session_id: "ses_fail",
          tool_name: "Bash",
          tool_input: "rm -rf /",
          error: "permission denied",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("opencode");
      expect(observeBody?.hookType).toBe("post_tool_failure");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("stop hook captures agentId in /session/turn-end call", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "stop.mjs",
        JSON.stringify({
          session_id: "ses_turn",
          turn_id: "turn_1",
          cwd: "/tmp/project",
          model: "gpt-test",
          last_assistant_message: "turning",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      const turnBody = bodies.find((b) => paths.includes(`/agentmemory/session/turn-end`));
      expect(turnBody).toBeTruthy();
      expect(turnBody?.agentId).toBe("opencode");
      expect(turnBody?.sessionId).toBe("ses_turn");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("session-end hook captures agentId in /observe and /session/end calls", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    const transcriptDir = mkdtempSync(join(tmpdir(), "agentmemory-transcript-"));
    const transcriptPath = join(transcriptDir, "session.jsonl");
    writeFileSync(
      transcriptPath,
      JSON.stringify({ role: "user", message: { content: [{ type: "text", text: "fix the flaky test" }] } }) + "\n",
    );

    try {
      await runHook(
        "session-end.mjs",
        JSON.stringify({
          session_id: "ses_closing",
          cwd: "/tmp/project",
          transcript_path: transcriptPath,
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      // Allow the fire-and-forget transcript /observe fetches to flush.
      await new Promise((resolve) => setTimeout(resolve, 700));

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      const endBody = bodies.find((b) => paths.includes(`/agentmemory/session/end`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("opencode");
      expect(observeBody?.data?.prompt).toBe("fix the flaky test");
      expect(endBody).toBeTruthy();
      expect(endBody?.sessionId).toBe("ses_closing");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
      rmSync(transcriptDir, { recursive: true, force: true });
    }
  });

  it("notification hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "notification.mjs",
        JSON.stringify({
          session_id: "ses_notify",
          notification_type: "permission_prompt",
          title: "Allow?",
          message: "edit this file",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("opencode");
      expect(observeBody?.hookType).toBe("notification");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });

  it("task-completed hook captures agentId in /observe telemetry", async () => {
    const { server, port, paths, bodies, respond } = await startServer();
    respond(() => ({ success: true }));

    try {
      await runHook(
        "task-completed.mjs",
        JSON.stringify({
          session_id: "ses_task",
          task_id: "task_1",
          task_subject: "fix bug",
          cwd: "/tmp/project",
        }),
        {
          AGENTMEMORY_URL: `http://127.0.0.1:${port}`,
          OPENCODE: "1",
        },
      );

      const observeBody = bodies.find((b) => paths.includes(`/agentmemory/observe`));
      expect(observeBody).toBeTruthy();
      expect(observeBody?.agentId).toBe("opencode");
      expect(observeBody?.hookType).toBe("task_completed");
    } finally {
      await new Promise<void>((r) => server.close(() => r()));
    }
  });
});