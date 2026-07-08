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
  ): void | Promise<void>;
  addBatch?(
    items: Array<{
      obsId: string;
      sessionId: string;
      embedding: Float32Array;
    }>,
  ): Promise<{ ok: number; fail: number }>;
  remove(obsId: string): void | Promise<void>;
  search(
    query: Float32Array,
    limit?: number,
  ): VectorSearchHit[] | Promise<VectorSearchHit[]>;
  clear(): void | Promise<void>;
}
