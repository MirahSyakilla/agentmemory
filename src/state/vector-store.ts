import type { SearchScope } from "../types.js";

export interface VectorSearchHit {
  obsId: string;
  sessionId: string;
  score: number;
}

export interface VectorStore {
  readonly size: number;
  readonly backend?: string;
  add(
    obsId: string,
    sessionId: string,
    embedding: Float32Array,
    scope?: SearchScope,
  ): void | Promise<void>;
  addBatch?(
    items: Array<{
      obsId: string;
      sessionId: string;
      embedding: Float32Array;
      scope?: SearchScope;
    }>,
  ): Promise<{ ok: number; fail: number }>;
  remove(obsId: string): void | Promise<void>;
  search(
    query: Float32Array,
    limit?: number,
    scope?: SearchScope,
  ): VectorSearchHit[] | Promise<VectorSearchHit[]>;
  clear(): void | Promise<void>;
}
