import type { CompressedObservation } from "../types.js";

export interface LexicalSearchHit {
  obsId: string;
  sessionId: string;
  score: number;
}

export interface LexicalStore {
  readonly size: number;
  readonly capacity: number;
  readonly backend?: string;
  add(obs: CompressedObservation): void | Promise<void>;
  has(id: string): boolean;
  remove(id: string): void | Promise<void>;
  search(query: string, limit?: number): LexicalSearchHit[] | Promise<LexicalSearchHit[]>;
  clear(): void | Promise<void>;
}
