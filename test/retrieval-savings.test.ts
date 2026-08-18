import { describe, expect, it } from "vitest";
import {
  buildRetrievalSavingsStats,
  createRetrievalSavingsCalculator,
  RETRIEVAL_SAVINGS_CONSTANTS,
} from "../src/functions/retrieval-savings.js";
import { KV } from "../src/state/schema.js";

describe("retrieval savings", () => {
  it("prices a large full-corpus counterfactual with GPT-5.6 Sol long-context input rates", () => {
    const result = buildRetrievalSavingsStats(
      {
        textChars: 899700,
        textTokens: 299900,
        imageCount: 1,
        imageBytes: 123,
        imageTokens: 100,
        unknownImageCount: 0,
        totalTokens: 300000,
        observationCount: 3,
        memoryCount: 2,
        lessonCount: 1,
        calculatedAt: "2026-07-18T00:00:00.000Z",
        exceedsLongContextThreshold: true,
        exceedsContextWindow: false,
      },
      { measuredEvents: 2, returnedTokens: 100 },
    );

    expect(result.pricing.rateClass).toBe("long");
    expect(result.pricing.ratesPerMillionTokens).toMatchObject({
      input: 10,
      cachedInput: 1,
      cacheWrite: 12.5,
      output: 45,
    });
    expect(result.perFullCorpusLoad).toMatchObject({
      cachedReadUsd: 0.3,
      uncachedInputUsd: 3,
      cacheWriteUsd: 3.75,
      isBatchedCounterfactual: false,
    });
    expect(result.totalAcrossMcpCalls.estimatedTokensAvoided).toBe(599900);
    expect(result.totalAcrossMcpCalls.cachedReadUsd).toBe(0.5999);
    expect(result.assumptions.join(" ")).toContain("counterfactual");
  });

  it("does not claim accumulated savings before an explicit retrieval opportunity", () => {
    const result = buildRetrievalSavingsStats(
      {
        textChars: 300,
        textTokens: 100,
        imageCount: 0,
        imageBytes: 0,
        imageTokens: 0,
        unknownImageCount: 0,
        totalTokens: 100,
        observationCount: 1,
        memoryCount: 0,
        lessonCount: 0,
        calculatedAt: "2026-07-18T00:00:00.000Z",
        exceedsLongContextThreshold: false,
        exceedsContextWindow: false,
      },
      { measuredEvents: 0, returnedTokens: 0 },
    );

    expect(result.totalAcrossMcpCalls).toMatchObject({
      estimatedTokensAvoided: 0,
      cachedReadUsd: 0,
      uncachedInputUsd: 0,
      cacheWriteUsd: 0,
      avoidedPercent: null,
    });
    expect(result.perFullCorpusLoad.uncachedInputUsd).toBe(0.0005);
  });

  it("counts only retrievable latest and non-deleted rows and caches the corpus", async () => {
    const store = new Map<string, unknown[]>();
    store.set(KV.sessions, [
      {
        id: "s1",
        project: "app",
        cwd: "/tmp/app",
        startedAt: "2026-07-18T00:00:00.000Z",
        status: "completed",
        observationCount: 2,
      },
      {
        id: "s2",
        project: "other",
        cwd: "/tmp/other",
        startedAt: "2026-07-18T00:00:00.000Z",
        status: "completed",
        observationCount: 1,
      },
    ]);
    store.set(KV.observations("s1"), [
      { id: "o1", narrative: "included", imageRef: "/tmp/image.png" },
      { id: "raw", title: "raw only" },
    ]);
    store.set(KV.observations("s2"), [
      { id: "o2", narrative: "other project" },
    ]);
    store.set(KV.memories, [
      { id: "m1", isLatest: true, content: "included" },
      { id: "m2", isLatest: false, content: "old" },
      { id: "m3", isLatest: true, project: "other", content: "other" },
    ]);
    store.set(KV.lessons, [
      { id: "l1", content: "included", deleted: false, project: "app" },
      { id: "l2", content: "deleted", deleted: true, project: "app" },
    ]);
    const kv = {
      list: async <T>(scope: string): Promise<T[]> =>
        (store.get(scope) ?? []) as T[],
    };
    let imageCalls = 0;
    const calculate = createRetrievalSavingsCalculator(kv as never, {
      inspectImages: async (refs) => {
        imageCalls++;
        expect(refs).toEqual(["/tmp/image.png"]);
        return {
          imageCount: 1,
          imageBytes: 100,
          imageTokens: 64,
          unknownImageCount: 0,
        };
      },
    });

    const first = await calculate("app");
    const second = await calculate("app");
    expect(first.observationCount).toBe(1);
    expect(first.memoryCount).toBe(1);
    expect(first.lessonCount).toBe(1);
    expect(first.imageTokens).toBe(64);
    expect(second).toBe(first);
    expect(imageCalls).toBe(1);
    expect(RETRIEVAL_SAVINGS_CONSTANTS.contextWindowTokens).toBe(1_050_000);
  });
});
