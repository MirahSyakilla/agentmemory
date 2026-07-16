import type { EmbeddingProvider } from "../../types.js";
import { getEnvVar } from "../../config.js";
import { fetchWithTimeout } from "../_fetch.js";
import {
  DEFAULT_AZURE_API_VERSION,
  isAlternateBaseRetryableError,
  isAlternateBaseRetryableStatus,
  markAlternateBaseRetryable,
  buildAuthHeaders,
  buildEmbeddingUrl,
  detectAzure,
  formatHttpErrorBody,
  normalizeBaseUrl,
  resolveAlternateBaseUrl,
} from "../_openai-shared.js";

const DEFAULT_MODEL = "text-embedding-3-small";

/**
 * Known OpenAI embedding model dimensions. Extend as new models ship.
 * Override in any case via OPENAI_EMBEDDING_DIMENSIONS for custom or
 * self-hosted OpenAI-compatible endpoints returning non-standard sizes.
 */
const MODEL_DIMENSIONS: Record<string, number> = {
  "text-embedding-3-small": 1536,
  "text-embedding-3-large": 3072,
  "text-embedding-ada-002": 1536,
};

const DEFAULT_DIMENSIONS = MODEL_DIMENSIONS[DEFAULT_MODEL] ?? 1536;

function resolveDimensions(model: string, override: string | undefined): number {
  if (override !== undefined && override.trim().length > 0) {
    const parsed = parseInt(override, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) {
      throw new Error(
        `OPENAI_EMBEDDING_DIMENSIONS must be a positive integer, got: ${override}`,
      );
    }
    return parsed;
  }
  return MODEL_DIMENSIONS[model] ?? DEFAULT_DIMENSIONS;
}

/**
 * OpenAI-compatible embedding provider.
 *
 * Shares transport (URL builder, auth header, Azure detection) with
 * the OpenAI LLM provider via `_openai-shared` (#371). Same env knobs
 * pick up automatically: when `OPENAI_BASE_URL` points at an Azure
 * resource (`.openai.azure.com` hostname) the embedding request uses
 * Azure's `/embeddings` path with the `api-version` query param and
 * `api-key` header instead of `Authorization: Bearer`.
 *
 * Required env vars:
 *   OPENAI_EMBEDDING_API_KEY     — embedding API key
 *
 * Optional:
 *   OPENAI_BASE_URL              — base URL without path (default: https://api.openai.com).
 *                                  Azure: https://<resource>.openai.azure.com/openai/deployments/<deployment>
 *   OPENAI_EMBEDDING_BASE_URL    — embedding-specific base URL override (defaults
 *                                  to OPENAI_BASE_URL). Lets operators run
 *                                  embeddings on a separate endpoint from chat —
 *                                  e.g. local Ollama / LM Studio / llama.cpp /
 *                                  vLLM at http://localhost:1234 for unlimited
 *                                  free embeddings, while keeping chat
 *                                  completions on a rate-limited but high-quality
 *                                  hosted provider. Azure detection runs on
 *                                  whichever URL ends up selected.
 *   OPENAI_API_VERSION           — Azure api-version query param (default: 2024-08-01-preview)
 *   OPENAI_EMBEDDING_MODEL       — model name (default: text-embedding-3-small)
 *   OPENAI_EMBEDDING_DIMENSIONS  — override reported dimensions (required for
 *                                  custom / self-hosted models not in the
 *                                  MODEL_DIMENSIONS table above)
 */
export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  readonly name = "openai";
  readonly dimensions: number;
  private apiKey: string;
  private baseUrl: string;
  private fallbackBaseUrl: string | null;
  private model: string;
  private isAzure: boolean;
  private fallbackIsAzure: boolean;
  private azureApiVersion: string;

  constructor(apiKey?: string) {
    this.apiKey = apiKey || getEnvVar("OPENAI_EMBEDDING_API_KEY") || "";
    if (!this.apiKey) {
      throw new Error(
        "API key is required (via constructor or OPENAI_EMBEDDING_API_KEY)",
      );
    }
    // Embedding-specific base URL override; falls back to OPENAI_BASE_URL,
    // then normalizeBaseUrl's default. The chat-LLM path (src/providers/openai.ts)
    // still reads only OPENAI_BASE_URL, so setting OPENAI_EMBEDDING_BASE_URL
    // alone moves embeddings to the new endpoint without affecting chat.
    this.baseUrl = normalizeBaseUrl(
      getEnvVar("OPENAI_EMBEDDING_BASE_URL") || getEnvVar("OPENAI_BASE_URL"),
    );
    this.fallbackBaseUrl = resolveAlternateBaseUrl(
      this.baseUrl,
      getEnvVar("OPENAI_EMBEDDING_FALLBACK_BASE_URL") ||
        getEnvVar("OPENAI_FALLBACK_BASE_URL"),
    );
    this.model = getEnvVar("OPENAI_EMBEDDING_MODEL") || DEFAULT_MODEL;
    this.dimensions = resolveDimensions(
      this.model,
      getEnvVar("OPENAI_EMBEDDING_DIMENSIONS"),
    );
    this.isAzure = detectAzure(this.baseUrl);
    this.fallbackIsAzure = this.fallbackBaseUrl
      ? detectAzure(this.fallbackBaseUrl)
      : false;
    this.azureApiVersion =
      getEnvVar("OPENAI_API_VERSION") || DEFAULT_AZURE_API_VERSION;
  }

  async embed(text: string): Promise<Float32Array> {
    const [result] = await this.embedBatch([text]);
    return result;
  }

  async embedBatch(texts: string[]): Promise<Float32Array[]> {
    try {
      return await this.embedBatchWithBase(this.baseUrl, this.isAzure, texts);
    } catch (err) {
      if (
        !this.fallbackBaseUrl ||
        !isAlternateBaseRetryableError(err)
      ) {
        throw err;
      }
      return this.embedBatchWithBase(
        this.fallbackBaseUrl,
        this.fallbackIsAzure,
        texts,
      );
    }
  }

  private async embedBatchWithBase(
    baseUrl: string,
    isAzure: boolean,
    texts: string[],
  ): Promise<Float32Array[]> {
    const url = buildEmbeddingUrl(
      baseUrl,
      isAzure,
      this.azureApiVersion,
    );
    let response: Response;
    try {
      response = await fetchWithTimeout(url, {
        method: "POST",
        headers: buildAuthHeaders(this.apiKey, isAzure),
        body: JSON.stringify({
          model: this.model,
          input: texts,
        }),
      });
    } catch (err) {
      if (err instanceof Error) throw markAlternateBaseRetryable(err);
      throw err;
    }

    if (!response.ok) {
      const err = await response.text();
      const error = new Error(
        `OpenAI embedding failed (${response.status}): ${formatHttpErrorBody(err)}`,
      );
      if (isAlternateBaseRetryableStatus(response.status)) {
        throw markAlternateBaseRetryable(error);
      }
      throw error;
    }

    const data = (await response.json()) as {
      data: Array<{ embedding: number[] }>;
    };

    return data.data.map((d) => new Float32Array(d.embedding));
  }
}
