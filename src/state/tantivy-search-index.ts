import { mkdirSync } from "node:fs";
import {
  Document,
  Index,
  SchemaBuilder,
  type SearchHit,
} from "@oxdev03/node-tantivy-binding";
import type { CompressedObservation } from "../types.js";
import { SearchIndex } from "./search-index.js";

interface TantivyEntry {
  sessionId: string;
}

interface TantivySearchIndexOptions {
  path: string;
  heapSizeBytes: number;
  numThreads: number;
  maxEntries?: number;
}

function buildSchema() {
  return new SchemaBuilder()
    .addTextField("obsId", { stored: true, tokenizerName: "raw" })
    .addTextField("sessionId", { stored: true, tokenizerName: "raw" })
    .addTextField("title", { stored: true })
    .addTextField("subtitle", { stored: true })
    .addTextField("narrative", { stored: true })
    .addTextField("facts", { stored: false })
    .addTextField("concepts", { stored: false })
    .addTextField("files", { stored: false })
    .addTextField("type", { stored: true, tokenizerName: "raw" })
    .addTextField("body", { stored: false })
    .addUnsignedField("importance", { stored: true, indexed: true, fast: true })
    .build();
}

function docText(obs: CompressedObservation): string {
  return [
    obs.title,
    obs.subtitle ?? "",
    obs.narrative,
    ...obs.facts,
    ...obs.concepts,
    ...obs.files,
    obs.type,
  ].join(" ");
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    const first = value[0];
    return typeof first === "string" ? first : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

export class TantivySearchIndex extends SearchIndex {
  override readonly backend = "tantivy";
  private index: Index;
  private writer: ReturnType<Index["writer"]>;
  private tantivyEntries = new Map<string, TantivyEntry>();
  private readonly maxEntries: number;
  private bulkDepth = 0;
  private dirty = false;

  constructor(private options: TantivySearchIndexOptions) {
    super(options.maxEntries);
    mkdirSync(options.path, { recursive: true });
    this.maxEntries =
      Number.isFinite(options.maxEntries) && (options.maxEntries ?? 0) > 0
        ? Math.floor(options.maxEntries!)
        : Number.POSITIVE_INFINITY;
    this.index = new Index(buildSchema(), options.path, true);
    this.writer = this.index.writer(options.heapSizeBytes, options.numThreads);
  }

  override add(obs: CompressedObservation): void {
    if (this.tantivyEntries.has(obs.id)) {
      this.writer.deleteDocumentsByTerm("obsId", obs.id);
    }

    const doc = new Document();
    doc.addText("obsId", obs.id);
    doc.addText("sessionId", obs.sessionId);
    doc.addText("title", obs.title);
    if (obs.subtitle) doc.addText("subtitle", obs.subtitle);
    doc.addText("narrative", obs.narrative);
    doc.addText("facts", obs.facts.join(" "));
    doc.addText("concepts", obs.concepts.join(" "));
    doc.addText("files", obs.files.join(" "));
    doc.addText("type", obs.type);
    doc.addText("body", docText(obs));
    doc.addUnsigned("importance", Math.max(0, Math.floor(obs.importance ?? 0)));
    this.writer.addDocument(doc);
    this.tantivyEntries.delete(obs.id);
    this.tantivyEntries.set(obs.id, { sessionId: obs.sessionId });

    while (this.tantivyEntries.size > this.maxEntries) {
      const oldest = this.tantivyEntries.keys().next().value;
      if (!oldest) break;
      this.remove(oldest);
    }

    this.markDirty();
  }

  override has(id: string): boolean {
    return this.tantivyEntries.has(id);
  }

  override remove(id: string): void {
    if (!this.tantivyEntries.delete(id)) return;
    this.writer.deleteDocumentsByTerm("obsId", id);
    this.markDirty();
  }

  override search(
    query: string,
    limit = 20,
  ): Array<{ obsId: string; sessionId: string; score: number }> {
    if (!query.trim() || this.tantivyEntries.size === 0) return [];
    this.flush();
    const searcher = this.index.searcher();
    const [parsed] = this.index.parseQueryLenient(query, [
      "title",
      "subtitle",
      "narrative",
      "facts",
      "concepts",
      "files",
      "body",
    ]);
    const results = searcher.search(parsed, limit, true);
    return results.hits
      .map((hit: SearchHit) => {
        const doc = searcher.doc(hit.docAddress).toDict();
        const obsId = firstString((doc as Record<string, unknown>).obsId);
        const sessionId =
          firstString((doc as Record<string, unknown>).sessionId) ??
          (obsId ? this.tantivyEntries.get(obsId)?.sessionId : undefined);
        if (!obsId || !sessionId) return null;
        return {
          obsId,
          sessionId,
          score: hit.score ?? 0,
        };
      })
      .filter(
        (hit): hit is { obsId: string; sessionId: string; score: number } =>
          hit !== null,
      );
  }

  override get size(): number {
    return this.tantivyEntries.size;
  }

  override get capacity(): number {
    return this.maxEntries;
  }

  override clear(): void {
    this.tantivyEntries.clear();
    this.writer.deleteAllDocuments();
    this.markDirty();
  }

  override restoreFrom(other: SearchIndex): void {
    this.clear();
    const srcEntries = (other as unknown as { entries?: Map<string, unknown> })
      .entries;
    if (!srcEntries) return;
    for (const [obsId, raw] of srcEntries) {
      const sessionId = (raw as { sessionId?: unknown })?.sessionId;
      if (typeof obsId === "string" && typeof sessionId === "string") {
        this.tantivyEntries.set(obsId, { sessionId });
      }
    }
    this.flush();
  }

  override serialize(): string {
    return JSON.stringify({
      v: 1,
      backend: "tantivy",
      entries: Array.from(this.tantivyEntries.entries()),
    });
  }

  beginBulk(): void {
    this.bulkDepth++;
  }

  endBulk(): void {
    this.bulkDepth = Math.max(0, this.bulkDepth - 1);
    if (this.bulkDepth === 0) this.flush();
  }

  flush(): void {
    if (!this.dirty) return;
    this.writer.commit();
    this.index.reload();
    this.dirty = false;
  }

  private markDirty(): void {
    this.dirty = true;
    if (this.bulkDepth === 0) this.flush();
  }
}
