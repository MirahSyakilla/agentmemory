import { describe, expect, it } from "vitest";
import {
  compareHistoricalStrategies,
  estimateContextTokens,
  evaluateHistoricalTaskFixtures,
  expectedHistoricalEntityReferences,
  formatHistoricalStrategyReport,
  validateHistoricalTaskFixtures,
  type HistoricalTaskFixture,
  type HistoricalTaskStrategy,
} from "../eval/runner/historical-fixtures.js";

describe("historical task fixtures", () => {
  it("scores mixed entity kinds and scenario indicators deterministically", async () => {
    const fixtures: HistoricalTaskFixture[] = [
      {
        id: "incident-resolution",
        query: "Which evidence resolved the release incident?",
        expectedMemoryIds: ["mem-fix", "mem-postmortem"],
        expectedExperimentIds: ["exp-canary"],
        expectedArtifactIds: ["artifact-release"],
        expectedEvidenceIds: ["evidence-logs"],
        scenario: {
          id: "release-incident",
          category: "incident",
          tags: ["release", "regression"],
          conflict: true,
          temporal: true,
        },
      },
    ];
    const strategy: HistoricalTaskStrategy = {
      name: "mixed-results",
      retrieve: () => ({
        latencyMs: 8,
        contextTokens: 123,
        items: [
          { id: "artifact-release", kind: "artifact" },
          { id: "mem-distractor", kind: "memory" },
          { id: "mem-fix", kind: "memory" },
          { id: "exp-canary", kind: "experiment" },
          { id: "evidence-logs", kind: "evidence" },
          { id: "mem-postmortem", kind: "memory" },
        ],
      }),
    };

    const report = await evaluateHistoricalTaskFixtures(fixtures, [strategy], { k: 5 });
    const evaluation = report.strategies[0].evaluations[0];

    expect(expectedHistoricalEntityReferences(fixtures[0])).toEqual([
      { id: "mem-fix", kind: "memory" },
      { id: "mem-postmortem", kind: "memory" },
      { id: "exp-canary", kind: "experiment" },
      { id: "artifact-release", kind: "artifact" },
      { id: "evidence-logs", kind: "evidence" },
    ]);
    expect(evaluation.metrics).toMatchObject({
      recallAtK: 0.8,
      precisionAtK: 0.8,
      mrr: 1,
      hit: true,
      topRelevantRank: 1,
      relevantCount: 5,
      retrievedCount: 6,
      latencyMs: 8,
      contextTokens: 123,
    });
    expect(evaluation.metrics.ndcgAtK).toBeCloseTo(0.786, 3);
    expect(evaluation.indicators).toEqual({
      conflict: true,
      negative: undefined,
      temporal: true,
      negativeCorrect: undefined,
    });
    expect(report.strategies[0].indicators.conflict?.hitRate).toBe(1);
    expect(report.strategies[0].indicators.temporal?.recallAtK).toBe(0.8);
  });

  it("compares named strategies, measures negative correctness, and renders a stable report", async () => {
    const fixtures: HistoricalTaskFixture[] = [
      {
        id: "positive-memory",
        query: "What was the approved rollout?",
        expectedMemoryIds: ["mem-rollout"],
      },
      {
        id: "negative-lookup",
        query: "Was an unapproved rollback recorded?",
        scenario: { negative: true },
      },
    ];
    const strategies: HistoricalTaskStrategy[] = [
      {
        name: "zeta",
        retrieve: (fixture) =>
          fixture.id === "positive-memory"
            ? {
                latencyMs: 5,
                contextTokens: 30,
                items: [{ id: "mem-rollout", kind: "memory" }],
              }
            : { latencyMs: 8, contextTokens: 20, items: [] },
      },
      {
        name: "alpha",
        retrieve: (fixture) =>
          fixture.id === "positive-memory"
            ? {
                latencyMs: 10,
                contextTokens: 50,
                items: [{ id: "mem-distractor", kind: "memory" }],
              }
            : {
                latencyMs: 20,
                contextTokens: 70,
                items: [{ id: "mem-unexpected", kind: "memory" }],
              },
      },
    ];

    const report = await evaluateHistoricalTaskFixtures(fixtures, strategies, { k: 3 });
    const [alpha, zeta] = report.strategies;

    expect(report.strategies.map((strategy) => strategy.name)).toEqual(["alpha", "zeta"]);
    expect(report.comparison.baseline).toBe("alpha");
    expect(alpha.summary).toMatchObject({
      recallAtK: 0,
      precisionAtK: 0,
      mrr: 0,
      ndcgAtK: 0,
      hitRate: 0,
      averageLatencyMs: 15,
      latencyP50Ms: 15,
      averageContextTokens: 60,
    });
    expect(zeta.summary).toMatchObject({
      recallAtK: 0.5,
      precisionAtK: 1 / 6,
      mrr: 0.5,
      ndcgAtK: 0.5,
      hitRate: 0.5,
      averageLatencyMs: 6.5,
      latencyP50Ms: 6.5,
      averageContextTokens: 25,
    });
    expect(alpha.indicators.negative).toMatchObject({
      fixtureCount: 1,
      negativeCorrectRate: 0,
    });
    expect(zeta.indicators.negative).toMatchObject({
      fixtureCount: 1,
      negativeCorrectRate: 1,
    });
    expect(report.comparison.deltas).toEqual([
      {
        strategy: "alpha",
        recallAtKDelta: 0,
        precisionAtKDelta: 0,
        mrrDelta: 0,
        ndcgAtKDelta: 0,
        hitRateDelta: 0,
        averageLatencyMsDelta: 0,
        latencyP50MsDelta: 0,
        averageContextTokensDelta: 0,
      },
      {
        strategy: "zeta",
        recallAtKDelta: 0.5,
        precisionAtKDelta: 1 / 6,
        mrrDelta: 0.5,
        ndcgAtKDelta: 0.5,
        hitRateDelta: 0.5,
        averageLatencyMsDelta: -8.5,
        latencyP50MsDelta: -8.5,
        averageContextTokensDelta: -35,
      },
    ]);

    expect(formatHistoricalStrategyReport(report)).toContain("## Scenario Indicators");
    expect(formatHistoricalStrategyReport(report)).toContain("| zeta | negative | 1 |");
    expect(formatHistoricalStrategyReport(report)).toContain("Fixtures: 2 | K: 3 | Baseline: alpha");
  });

  it("deduplicates ranked items and deterministically estimates context tokens", async () => {
    const fixture: HistoricalTaskFixture = {
      id: "dedupe",
      query: "Find the memory",
      expectedMemoryIds: ["mem-1"],
    };
    const strategy: HistoricalTaskStrategy = {
      name: "dedupe",
      retrieve: () => ({
        latencyMs: 3,
        items: [
          { id: "mem-1", kind: "memory", contextTokens: 7 },
          { id: "mem-1", kind: "memory", contextTokens: 99 },
          { id: "artifact-1", kind: "artifact", context: "abcd" },
        ],
      }),
    };

    const report = await evaluateHistoricalTaskFixtures([fixture], [strategy], { k: 2 });
    const metrics = report.strategies[0].evaluations[0].metrics;

    expect(estimateContextTokens("")).toBe(0);
    expect(estimateContextTokens("abcd")).toBe(1);
    expect(metrics).toMatchObject({
      recallAtK: 1,
      precisionAtK: 0.5,
      retrievedCount: 2,
      contextTokens: 8,
    });
  });

  it("rejects invalid fixture and strategy comparison inputs", () => {
    expect(() =>
      validateHistoricalTaskFixtures([
        { id: "duplicate", query: "first" },
        { id: "duplicate", query: "second" },
      ]),
    ).toThrow("duplicate fixture id");
    expect(() =>
      compareHistoricalStrategies([
        {
          name: "one",
          k: 1,
          evaluations: [],
          summary: {
            fixtureCount: 0,
            recallAtK: 0,
            precisionAtK: 0,
            mrr: 0,
            ndcgAtK: 0,
            hitRate: 0,
            averageLatencyMs: 0,
            latencyP50Ms: 0,
            averageContextTokens: 0,
          },
          indicators: {},
        },
        {
          name: "two",
          k: 2,
          evaluations: [],
          summary: {
            fixtureCount: 0,
            recallAtK: 0,
            precisionAtK: 0,
            mrr: 0,
            ndcgAtK: 0,
            hitRate: 0,
            averageLatencyMs: 0,
            latencyP50Ms: 0,
            averageContextTokens: 0,
          },
          indicators: {},
        },
      ]),
    ).toThrow("same k");
  });
});
