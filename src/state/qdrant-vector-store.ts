import { createHash } from "node:crypto";
import type { VectorSearchHit, VectorStore } from "./vector-store.js";

interface QdrantVectorStoreOptions {
  url: string;
  collection: string;
  dimensions: number;
  apiKey?: string;
}

interface QdrantResponse<T> {
  result?: T;
  status?: string;
}

function pointIdFor(obsId: string): string {
  const hex = createHash("sha256").update(obsId).digest("hex").slice(0, 32);
  const variant = ((parseInt(hex.slice(16, 18), 16) & 0x3f) | 0x80)
    .toString(16)
    .padStart(2, "0");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    `4${hex.slice(13, 16)}`,
    `${variant}${hex.slice(18, 20)}`,
    hex.slice(20, 32),
  ].join("-");
}

function vectorToArray(vector: Float32Array): number[] {
  return Array.from(vector);
}

export class QdrantVectorStore implements VectorStore {
  readonly backend = "qdrant";
  private baseUrl: string;
  private ready: Promise<void> | null = null;
  private cachedSize = 0;

  constructor(private options: QdrantVectorStoreOptions) {
    this.baseUrl = options.url.replace(/\/+$/, "");
  }

  get size(): number {
    return this.cachedSize;
  }

  async ensureReady(): Promise<void> {
    if (!this.ready) this.ready = this.ensureCollection();
    await this.ready;
  }

  async add(
    obsId: string,
    sessionId: string,
    embedding: Float32Array,
  ): Promise<void> {
    await this.addBatch([{ obsId, sessionId, embedding }]);
  }

  async addBatch(
    items: Array<{
      obsId: string;
      sessionId: string;
      embedding: Float32Array;
    }>,
  ): Promise<{ ok: number; fail: number }> {
    if (items.length === 0) return { ok: 0, fail: 0 };
    await this.ensureReady();

    const points = items.map((item) => ({
      id: pointIdFor(item.obsId),
      vector: vectorToArray(item.embedding),
      payload: {
        obsId: item.obsId,
        sessionId: item.sessionId,
      },
    }));

    await this.request(
      "PUT",
      `/collections/${encodeURIComponent(this.options.collection)}/points?wait=true`,
      { points },
    );
    this.cachedSize += points.length;
    return { ok: points.length, fail: 0 };
  }

  async remove(obsId: string): Promise<void> {
    await this.ensureReady();
    await this.request(
      "POST",
      `/collections/${encodeURIComponent(this.options.collection)}/points/delete?wait=true`,
      { points: [pointIdFor(obsId)] },
    );
    this.cachedSize = Math.max(0, this.cachedSize - 1);
  }

  async search(query: Float32Array, limit = 20): Promise<VectorSearchHit[]> {
    await this.ensureReady();
    const data = await this.request<
      Array<{ score?: number; payload?: Record<string, unknown> }>
    >(
      "POST",
      `/collections/${encodeURIComponent(this.options.collection)}/points/search`,
      {
        vector: vectorToArray(query),
        limit,
        with_payload: true,
      },
    );

    return (data.result ?? [])
      .map((row) => {
        const obsId = row.payload?.obsId;
        const sessionId = row.payload?.sessionId;
        if (typeof obsId !== "string" || typeof sessionId !== "string") {
          return null;
        }
        return {
          obsId,
          sessionId,
          score: typeof row.score === "number" ? row.score : 0,
        };
      })
      .filter((row): row is VectorSearchHit => row !== null);
  }

  async clear(): Promise<void> {
    await this.request(
      "DELETE",
      `/collections/${encodeURIComponent(this.options.collection)}`,
      undefined,
      { allowNotFound: true },
    );
    this.ready = null;
    this.cachedSize = 0;
    await this.ensureReady();
  }

  private async ensureCollection(): Promise<void> {
    const path = `/collections/${encodeURIComponent(this.options.collection)}`;
    const existing = await this.request<{
      config?: { params?: { vectors?: { size?: number } } };
      points_count?: number;
      vectors_count?: number;
    }>("GET", path, undefined, { allowNotFound: true });

    if (existing.status !== "not_found" && existing.result) {
      const size = existing.result.config?.params?.vectors?.size;
      if (typeof size === "number" && size !== this.options.dimensions) {
        throw new Error(
          `Qdrant collection '${this.options.collection}' has vector size ${size}, expected ${this.options.dimensions}`,
        );
      }
      this.cachedSize =
        existing.result.points_count ?? existing.result.vectors_count ?? 0;
      return;
    }

    await this.request("PUT", path, {
      vectors: {
        size: this.options.dimensions,
        distance: "Cosine",
      },
    });
    this.cachedSize = 0;
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    options: { allowNotFound?: boolean } = {},
  ): Promise<QdrantResponse<T>> {
    const headers: Record<string, string> = {
      "content-type": "application/json",
    };
    if (this.options.apiKey) headers["api-key"] = this.options.apiKey;

    const res = await fetch(`${this.baseUrl}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (res.status === 404 && options.allowNotFound) {
      return { status: "not_found" };
    }
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(
        `Qdrant ${method} ${path} failed: HTTP ${res.status}${text ? ` ${text.slice(0, 500)}` : ""}`,
      );
    }
    if (res.status === 204) return {};
    return (await res.json()) as QdrantResponse<T>;
  }
}
