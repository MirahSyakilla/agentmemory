import type { MemoryProvider } from "../types.js";
import { getEnvVar } from "../config.js";
import { fetchWithTimeout } from "./_fetch.js";
import {
  DEFAULT_AZURE_API_VERSION,
  buildAuthHeaders,
  buildChatUrl,
  buildResponseUrl,
  detectAzure,
  formatHttpErrorBody,
  normalizeBaseUrl,
} from "./_openai-shared.js";

const DEFAULT_MODEL = "gpt-4o-mini";
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * OpenAI-compatible LLM provider.
 *
 * Uses raw fetch (no SDK) to support any OpenAI-compatible endpoint:
 *   - OpenAI official
 *   - Azure OpenAI (auto-detected from .openai.azure.com host)
 *   - DeepSeek
 *   - 硅基流动 (SiliconFlow)
 *   - vLLM / LM Studio / Ollama (with OpenAI compatibility layer)
 *   - Any other proxy implementing /v1/responses
 *
 * Required env vars:
 *   OPENAI_API_KEY  — API key
 *
 * Optional:
 *   OPENAI_BASE_URL          — base URL without path (default: https://api.openai.com).
 *                              Azure: https://<resource>.openai.azure.com/openai/deployments/<deployment>
 *   OPENAI_MODEL             — model name (default: gpt-4o-mini)
 *   OPENAI_API_VERSION       — Azure api-version query param (default: 2024-08-01-preview)
 *   OPENAI_TIMEOUT_MS        — outbound fetch timeout in ms (OpenAI-scoped alias,
 *                              takes precedence over AGENTMEMORY_LLM_TIMEOUT_MS
 *                              for back-compat with the v0.9.17 shipping name).
 *   AGENTMEMORY_LLM_TIMEOUT_MS — outbound fetch timeout in ms shared across all
 *                              raw-fetch LLM + embedding providers. Used when
 *                              OPENAI_TIMEOUT_MS is not set. Default: 60000.
 *   MAX_TOKENS               — max output tokens (default: from config or 4096)
 *   OPENAI_REASONING_EFFORT  — "low" | "medium" | "high" | "none"
 *                              Passed through to the Responses API reasoning block.
 */
export class OpenAIProvider implements MemoryProvider {
  name = "openai";
  private apiKey: string;
  private model: string;
  private maxTokens: number;
  private baseUrl: string;
  private reasoningEffort?: string;
  private timeoutMs: number;
  private isAzure: boolean;
  private azureApiVersion: string;

  constructor(apiKey: string, model: string, maxTokens: number, baseURL?: string) {
    this.apiKey = apiKey;
    this.model = model;
    this.maxTokens = maxTokens;
    this.baseUrl = normalizeBaseUrl(baseURL || getEnvVar("OPENAI_BASE_URL"));
    this.reasoningEffort = getEnvVar("OPENAI_REASONING_EFFORT") || undefined;
    this.timeoutMs = resolveTimeout();
    this.azureApiVersion =
      getEnvVar("OPENAI_API_VERSION") || DEFAULT_AZURE_API_VERSION;
    this.isAzure = detectAzure(this.baseUrl);
  }

  async compress(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  async summarize(systemPrompt: string, userPrompt: string): Promise<string> {
    return this.call(systemPrompt, userPrompt);
  }

  private async call(systemPrompt: string, userPrompt: string): Promise<string> {
    const response = await this.sendResponses(systemPrompt, userPrompt);
    if (response.ok) {
      const data = (await response.json()) as ResponsesPayload;
      const content = extractResponsesText(data);
      if (content) return content;
      throw new Error(
        `OpenAI returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
      );
    }

    const errorText = await response.text();
    if (shouldFallbackToChat(response.status, errorText)) {
      return this.callChat(systemPrompt, userPrompt);
    }
    throw new Error(
      `OpenAI API error (${response.status}): ${formatHttpErrorBody(errorText)}`,
    );
  }

  private async sendResponses(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<Response> {
    let includeTokenCap = true;
    while (true) {
      const response = await this.sendResponsesRequest(
        systemPrompt,
        userPrompt,
        includeTokenCap,
      );
      if (response.ok) return response;
      if (!includeTokenCap) return response;
      const errorText = await response.text();
      if (!isResponsesTokenParamError(response.status, errorText)) {
        return new Response(errorText, {
          status: response.status,
          headers: response.headers,
        });
      }
      includeTokenCap = false;
    }
  }

  private async sendResponsesRequest(
    systemPrompt: string,
    userPrompt: string,
    includeTokenCap: boolean,
  ): Promise<Response> {
    const url = buildResponseUrl(
      this.baseUrl,
      this.isAzure,
      this.azureApiVersion,
    );
    const body: Record<string, unknown> = {
      model: this.model,
      instructions: systemPrompt,
      input: userPrompt,
      stream: false,
    };
    if (includeTokenCap) {
      body.max_output_tokens = this.maxTokens;
    }
    if (this.reasoningEffort && this.reasoningEffort !== "none") {
      body.reasoning = { effort: this.reasoningEffort };
    }
    return this.fetchJson(url, body);
  }

  private async callChat(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<string> {
    const url = buildChatUrl(this.baseUrl, this.isAzure, this.azureApiVersion);
    const body: Record<string, unknown> = {
      model: this.model,
      // OpenAI API spec defines `stream` as defaulting to false, so omitting
      // it should yield a JSON response. Some OpenAI-compatible proxies
      // (notably 9Router < 0.4.56 — see decolua/9router#1260) default to
      // text/event-stream when `stream` is absent, which crashes the
      // `response.json()` call below with `Unexpected token 'd', "data: {"id"...`.
      // Send it explicitly so non-spec endpoints route to non-streaming too.
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt },
      ],
    };
    body.max_tokens = this.maxTokens;
    if (this.reasoningEffort) {
      body.reasoning_effort = this.reasoningEffort;
    }
    const response = await this.fetchJson(url, body);
    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `OpenAI API error (${response.status}): ${formatHttpErrorBody(text)}`,
      );
    }
    const data = (await response.json()) as ChatCompletionsPayload;
    const content = extractChatText(data);
    if (content) return content;
    throw new Error(
      `OpenAI returned unexpected response: ${JSON.stringify(data).slice(0, 200)}`,
    );
  }

  private async fetchJson(
    url: string,
    body: Record<string, unknown>,
  ): Promise<Response> {
    // Bound the request via the shared fetchWithTimeout helper, which
    // owns the AbortController + clearTimeout cleanup for every raw-fetch
    // provider (minimax, openrouter, gemini, openrouter-embed, etc.).
    // OPENAI_TIMEOUT_MS keeps its v0.9.17 meaning (OpenAI-scoped alias,
    // takes precedence); when unset we fall through to
    // AGENTMEMORY_LLM_TIMEOUT_MS and finally the 60s default. See #446.
    let response: Response;
    try {
      response = await fetchWithTimeout(
        url,
        {
          method: "POST",
          headers: buildAuthHeaders(this.apiKey, this.isAzure),
          body: JSON.stringify(body),
        },
        this.timeoutMs,
      );
    } catch (err) {
      const aborted = err instanceof Error && err.name === "AbortError";
      if (aborted) {
        throw new Error(
          `OpenAI API request timed out after ${this.timeoutMs}ms — set OPENAI_TIMEOUT_MS (or AGENTMEMORY_LLM_TIMEOUT_MS) to raise the bound or check the provider status.`,
        );
      }
      throw err;
    }
    return response;
  }
}

type ResponsesPayload = {
  output_text?: string;
  output?: Array<{
    type?: string;
    content?: Array<{
      type?: string;
      text?: string;
    }>;
  }>;
  choices?: Array<{
    message?: { content?: string; reasoning?: string; reasoning_content?: string };
  }>;
};

type ChatCompletionsPayload = {
  choices?: Array<{
    message?: { content?: string; reasoning?: string; reasoning_content?: string };
  }>;
};

function extractResponsesText(data: ResponsesPayload): string | null {
  if (typeof data.output_text === "string" && data.output_text.length > 0) {
    return data.output_text;
  }
  for (const item of data.output ?? []) {
    if (item.type !== "message") continue;
    for (const content of item.content ?? []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string" &&
        content.text.length > 0
      ) {
        return content.text;
      }
    }
  }
  return extractChatText(data);
}

function extractChatText(data: ChatCompletionsPayload): string | null {
  const message = data.choices?.[0]?.message;
  const content = message?.content;
  if (content) return content;
  const reasoning = message?.reasoning ?? message?.reasoning_content;
  return reasoning || null;
}

function isResponsesTokenParamError(status: number, errorText: string): boolean {
  if (status !== 400 && status !== 422) return false;
  const lower = errorText.toLowerCase();
  return (
    /(unsupported|unknown|unrecognized|invalid).{0,80}parameter/.test(lower) &&
    /max_output_tokens/.test(lower)
  );
}

function shouldFallbackToChat(status: number, errorText: string): boolean {
  if (status === 404 || status === 405 || status === 501) return true;
  if (status !== 400 && status !== 422) return false;
  const lower = errorText.toLowerCase();
  return (
    /responses/.test(lower) &&
    /(unsupported|unknown|unrecognized|not found|invalid url|no route|does not exist)/.test(lower)
  );
}

// Resolves the outbound-fetch timeout for the OpenAI LLM path.
// Precedence (preserving v0.9.17 behaviour):
//   1. OPENAI_TIMEOUT_MS       — OpenAI-scoped alias (back-compat)
//   2. AGENTMEMORY_LLM_TIMEOUT_MS — global LLM/embedding timeout (#446)
//   3. 60 000 ms default
function resolveTimeout(): number {
  const openaiRaw = getEnvVar("OPENAI_TIMEOUT_MS");
  const openai = parsePositiveInt(openaiRaw);
  if (openai !== undefined) return openai;

  const globalRaw = getEnvVar("AGENTMEMORY_LLM_TIMEOUT_MS");
  const globalMs = parsePositiveInt(globalRaw);
  if (globalMs !== undefined) return globalMs;

  return DEFAULT_TIMEOUT_MS;
}

function parsePositiveInt(raw: string | null | undefined): number | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  // Reject malformed values like "30ms" or "1_000" — parseInt would
  // silently return 30 / 1, swallowing user typos as valid timeouts.
  // The regex enforces pure digits (no sign, no trailing units, no
  // separators) before we hand off to Number.
  if (!/^\d+$/.test(trimmed)) return undefined;
  const n = Number(trimmed);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}
