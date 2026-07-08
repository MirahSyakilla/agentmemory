import { describe, it, expect, vi, afterEach, beforeEach } from "vitest";
import { fetchWithTimeout } from "../src/providers/_fetch.js";
import { MinimaxProvider } from "../src/providers/minimax.js";
import { OpenRouterProvider } from "../src/providers/openrouter.js";
import { OpenAIProvider } from "../src/providers/openai.js";
import { GeminiEmbeddingProvider } from "../src/providers/embedding/gemini.js";
import { OpenAIEmbeddingProvider } from "../src/providers/embedding/openai.js";
import { CohereEmbeddingProvider } from "../src/providers/embedding/cohere.js";
import { VoyageEmbeddingProvider } from "../src/providers/embedding/voyage.js";
import { OpenRouterEmbeddingProvider } from "../src/providers/embedding/openrouter.js";

// A fetch mock that never resolves — simulates a hung upstream.
function hangingFetch(_url: string, _init?: RequestInit): Promise<Response> {
  // honour AbortSignal so the timeout actually cancels us
  const init = _init ?? {};
  return new Promise<Response>((_resolve, reject) => {
    if (init.signal) {
      if (init.signal.aborted) {
        reject(new DOMException("AbortError", "AbortError"));
        return;
      }
      init.signal.addEventListener("abort", () => {
        reject(new DOMException("AbortError", "AbortError"));
      });
    }
  });
}

// ─────────────────────────────────────────────────────────────
// fetchWithTimeout unit tests
// ─────────────────────────────────────────────────────────────
describe("fetchWithTimeout", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
  });

  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("resolves normally when fetch completes within the timeout", async () => {
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(JSON.stringify({ ok: true }), { status: 200 }),
    );
    const res = await fetchWithTimeout("https://example.com", {}, 1000);
    expect(res.status).toBe(200);
  });

  it("aborts with an AbortError when fetch hangs beyond the configured timeout", async () => {
    await expect(
      fetchWithTimeout("https://example.com", {}, 50),
    ).rejects.toThrow();
  });

  it("reads AGENTMEMORY_LLM_TIMEOUT_MS as the default timeout when no explicit ms is given", async () => {
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
    // no explicit third arg — must pick up the env var
    await expect(
      fetchWithTimeout("https://example.com", {}),
    ).rejects.toThrow();
  });

  it("falls back to 60 000 ms when AGENTMEMORY_LLM_TIMEOUT_MS is not set (type check only)", () => {
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    vi.restoreAllMocks();
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(null, { status: 204 }),
    );
    const p = fetchWithTimeout("https://example.com", {});
    expect(p).toBeInstanceOf(Promise);
    return p;
  });
});

// ─────────────────────────────────────────────────────────────
// Provider hang regression tests
// Each provider must call fetchWithTimeout, which honours the
// AbortSignal when the explicit timeoutMs is tiny (50 ms).
// ─────────────────────────────────────────────────────────────

describe("Provider hang regression — MinimaxProvider", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("compress() aborts after timeout when upstream hangs", async () => {
    const provider = new MinimaxProvider("test-key", "MiniMax-M2.7", 800);
    await expect(provider.compress("system", "user")).rejects.toThrow();
  });
});

describe("Provider hang regression — OpenRouterProvider (covers Gemini LLM path)", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("compress() aborts after timeout when upstream hangs", async () => {
    const provider = new OpenRouterProvider(
      "test-key",
      "gemini-2.5-flash",
      1024,
      "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions",
    );
    await expect(provider.compress("system", "user")).rejects.toThrow();
  });
});

describe("Provider hang regression — GeminiEmbeddingProvider", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("embedBatch() aborts after timeout when upstream hangs", async () => {
    const provider = new GeminiEmbeddingProvider("test-key");
    await expect(provider.embedBatch(["hello"])).rejects.toThrow();
  });
});

describe("Provider hang regression — OpenAIEmbeddingProvider", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("embedBatch() aborts after timeout when upstream hangs", async () => {
    const provider = new OpenAIEmbeddingProvider("test-key");
    await expect(provider.embedBatch(["hello"])).rejects.toThrow();
  });
});

describe("Provider hang regression — CohereEmbeddingProvider", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("embedBatch() aborts after timeout when upstream hangs", async () => {
    const provider = new CohereEmbeddingProvider("test-key");
    await expect(provider.embedBatch(["hello"])).rejects.toThrow();
  });
});

describe("Provider hang regression — VoyageEmbeddingProvider", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("embedBatch() aborts after timeout when upstream hangs", async () => {
    const provider = new VoyageEmbeddingProvider("test-key");
    await expect(provider.embedBatch(["hello"])).rejects.toThrow();
  });
});

describe("Provider hang regression — OpenRouterEmbeddingProvider", () => {
  beforeEach(() => {
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "50";
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("embedBatch() aborts after timeout when upstream hangs", async () => {
    const provider = new OpenRouterEmbeddingProvider("test-key");
    await expect(provider.embedBatch(["hello"])).rejects.toThrow();
  });
});

// ─────────────────────────────────────────────────────────────
// #446 — OpenAI LLM provider env-var precedence
//
// v0.9.17 shipped OPENAI_TIMEOUT_MS (OpenAI-scoped). PR #379 then
// shipped AGENTMEMORY_LLM_TIMEOUT_MS (shared). The provider now
// honours both: OPENAI_TIMEOUT_MS wins for back-compat, with
// AGENTMEMORY_LLM_TIMEOUT_MS as the global fall-back.
// ─────────────────────────────────────────────────────────────
describe("OpenAIProvider timeout env precedence (#446)", () => {
  beforeEach(() => {
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
    vi.spyOn(globalThis, "fetch").mockImplementation(hangingFetch as typeof fetch);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });

  it("OPENAI_TIMEOUT_MS alone aborts the OpenAI LLM call", async () => {
    process.env["OPENAI_TIMEOUT_MS"] = "30";
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    await expect(provider.compress("system", "user")).rejects.toThrow(
      /timed out after 30ms/,
    );
  });

  it("AGENTMEMORY_LLM_TIMEOUT_MS alone aborts the OpenAI LLM call", async () => {
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "30";
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    await expect(provider.compress("system", "user")).rejects.toThrow(
      /timed out after 30ms/,
    );
  });

  it("OPENAI_TIMEOUT_MS wins when both are set (back-compat)", async () => {
    process.env["OPENAI_TIMEOUT_MS"] = "30";
    // Set the global to a much larger value — if precedence is wrong,
    // we'd time out at 5000ms and the test would hang past the 5s
    // vitest default. We assert the message ms to lock the precedence.
    process.env["AGENTMEMORY_LLM_TIMEOUT_MS"] = "5000";
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    await expect(provider.compress("system", "user")).rejects.toThrow(
      /timed out after 30ms/,
    );
  });

  it("falls back to the 60 000 ms default when neither is set", () => {
    // We don't actually wait 60s — the provider stores timeoutMs at
    // construction. Construct, then assert the bound via the error
    // message after the hang aborts at a tiny pre-set value.
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    // Access the resolved timeout via the constructed field name. The
    // class keeps `timeoutMs` private; reaching in via the index
    // access keeps the test on the public observed behaviour: the ms
    // value reported in the timeout error message must be 60000.
    const ms = (provider as unknown as { timeoutMs: number }).timeoutMs;
    expect(ms).toBe(60_000);
  });

  it("rejects malformed env values like '30ms' or '1_000' (CodeRabbit catch)", () => {
    // parseInt would have silently returned 30 / 1 for these typos —
    // strict parse now rejects them and the provider falls back to
    // the 60 000 ms default so a malformed env doesn't masquerade as
    // an aggressive bound.
    // Whitespace-only padding (" 30 ") is legitimate env-var handling — we
    // trim before validating. The cases below are real typos parseInt would
    // silently swallow.
    for (const bad of ["30ms", "1_000", "60s", "30abc", "-30", "0"]) {
      process.env["OPENAI_TIMEOUT_MS"] = bad;
      const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
      const ms = (provider as unknown as { timeoutMs: number }).timeoutMs;
      expect(ms).toBe(60_000);
      delete process.env["OPENAI_TIMEOUT_MS"];
    }
  });
});

// ─────────────────────────────────────────────────────────────
// #627 — OpenAI provider must read message.reasoning_content
// DeepSeek V4 / Qwen3 / GLM / Kimi return reasoning_content (with
// underscore); only checking `reasoning` left thinking-model output
// dropped on the floor and tripped the compress circuit breaker.
// ─────────────────────────────────────────────────────────────
describe("OpenAIProvider thinking-model fallback (#627)", () => {
  beforeEach(() => {
    delete process.env["OPENAI_TIMEOUT_MS"];
    delete process.env["AGENTMEMORY_LLM_TIMEOUT_MS"];
  });
  afterEach(() => {
    vi.restoreAllMocks();
  });

  function mockOpenAIResponse(body: object): void {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
  }

  it("returns reasoning_content when content is empty (DeepSeek V4 / Qwen3 shape)", async () => {
    mockOpenAIResponse({
      choices: [
        {
          message: {
            content: "",
            reasoning_content: "thinking-mode output",
          },
        },
      ],
    });
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    const out = await provider.compress("system", "user");
    expect(out).toBe("thinking-mode output");
  });

  it("still returns reasoning (no underscore) for older o-series shape", async () => {
    mockOpenAIResponse({
      choices: [{ message: { content: "", reasoning: "older shape" } }],
    });
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    const out = await provider.compress("system", "user");
    expect(out).toBe("older shape");
  });

  it("content wins over both reasoning fields when present", async () => {
    mockOpenAIResponse({
      choices: [
        {
          message: {
            content: "real content",
            reasoning: "ignore",
            reasoning_content: "also ignore",
          },
        },
      ],
    });
    const provider = new OpenAIProvider("test-key", "gpt-4o-mini", 1024);
    const out = await provider.compress("system", "user");
    expect(out).toBe("real content");
  });
});

describe("OpenAIProvider Responses API transport", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("uses /v1/responses with instructions, input, and max_output_tokens", async () => {
    let capturedUrl = "";
    let capturedBody: Record<string, unknown> = {};
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async (url: string | URL | Request, init?: RequestInit) => {
        capturedUrl = String(url);
        capturedBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
        return new Response(
          JSON.stringify({ output_text: "ok" }),
          { status: 200 },
        );
      }) as typeof fetch,
    );

    const provider = new OpenAIProvider(
      "test-key",
      "gpt-compatible",
      1024,
      "https://proxy.example.com",
    );

    await expect(provider.compress("system", "user")).resolves.toBe("ok");
    expect(capturedUrl).toBe("https://proxy.example.com/v1/responses");
    expect(capturedBody).toMatchObject({
      model: "gpt-compatible",
      instructions: "system",
      input: "user",
      max_output_tokens: 1024,
      stream: false,
    });
    expect(capturedBody).not.toHaveProperty("messages");
    expect(capturedBody).not.toHaveProperty("max_tokens");
  });

  it("parses Responses output message content", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async () =>
        new Response(
          JSON.stringify({
            output: [
              {
                type: "message",
                content: [{ type: "output_text", text: "nested ok" }],
              },
            ],
          }),
          { status: 200 },
        )) as typeof fetch,
    );

    const provider = new OpenAIProvider(
      "test-key",
      "gpt-compatible",
      1024,
      "https://proxy.example.com",
    );

    await expect(provider.summarize("system", "user")).resolves.toBe(
      "nested ok",
    );
  });

  it("retries Responses without max_output_tokens when a proxy rejects that field", async () => {
    const bodies: Array<Record<string, unknown>> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async (_url: string | URL | Request, init?: RequestInit) => {
        bodies.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
        if (bodies.length === 1) {
          return new Response(
            JSON.stringify({
              error: { message: "Unsupported parameter: max_output_tokens" },
            }),
            { status: 400 },
          );
        }
        return new Response(JSON.stringify({ output_text: "ok" }), {
          status: 200,
        });
      }) as typeof fetch,
    );

    const provider = new OpenAIProvider(
      "test-key",
      "gpt-compatible",
      1024,
      "https://proxy.example.com",
    );

    await expect(provider.summarize("system", "user")).resolves.toBe("ok");
    expect(bodies[0].max_output_tokens).toBe(1024);
    expect(bodies[1]).not.toHaveProperty("max_output_tokens");
  });

  it("falls back to chat completions only when /responses is unavailable", async () => {
    const urls: string[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(
      (async (url: string | URL | Request) => {
        urls.push(String(url));
        if (urls.length === 1) {
          return new Response(
            JSON.stringify({ error: { message: "responses route not found" } }),
            { status: 404 },
          );
        }
        return new Response(
          JSON.stringify({ choices: [{ message: { content: "chat ok" } }] }),
          { status: 200 },
        );
      }) as typeof fetch,
    );

    const provider = new OpenAIProvider(
      "test-key",
      "gpt-compatible",
      1024,
      "https://proxy.example.com",
    );

    await expect(provider.compress("system", "user")).resolves.toBe("chat ok");
    expect(urls).toEqual([
      "https://proxy.example.com/v1/responses",
      "https://proxy.example.com/v1/chat/completions",
    ]);
  });
});
