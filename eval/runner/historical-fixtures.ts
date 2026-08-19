export type HistoricalEntityKind = "memory" | "experiment" | "artifact" | "evidence";

export interface HistoricalScenarioMetadata {
  id?: string;
  category?: string;
  tags?: readonly string[];
  conflict?: boolean;
  negative?: boolean;
  temporal?: boolean;
  [key: string]: unknown;
}

export interface HistoricalTaskFixture {
  id: string;
  query: string;
  expectedMemoryIds?: readonly string[];
  expectedExperimentIds?: readonly string[];
  expectedArtifactIds?: readonly string[];
  expectedEvidenceIds?: readonly string[];
  scenario?: HistoricalScenarioMetadata;
}

export interface HistoricalEntityReference {
  id: string;
  kind: HistoricalEntityKind;
}

export interface HistoricalRetrievedItem {
  id: string;
  kind: HistoricalEntityKind;
  score?: number;
  context?: string;
  contextTokens?: number;
  metadata?: Record<string, unknown>;
}

export interface HistoricalStrategyResult {
  items: readonly HistoricalRetrievedItem[];
  latencyMs: number;
  contextTokens?: number;
}

export interface HistoricalTaskStrategy {
  name: string;
  retrieve(
    fixture: HistoricalTaskFixture,
    k: number,
  ): HistoricalStrategyResult | Promise<HistoricalStrategyResult>;
}

export interface HistoricalTaskMetrics {
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
  hit: boolean;
  topRelevantRank: number | null;
  relevantCount: number;
  retrievedCount: number;
  latencyMs: number;
  contextTokens: number;
}

export interface HistoricalScenarioIndicators {
  conflict?: boolean;
  negative?: boolean;
  temporal?: boolean;
  negativeCorrect?: boolean;
}

export interface HistoricalFixtureEvaluation {
  fixtureId: string;
  query: string;
  strategy: string;
  scenario?: HistoricalScenarioMetadata;
  indicators: HistoricalScenarioIndicators;
  metrics: HistoricalTaskMetrics;
}

export interface HistoricalMetricSummary {
  fixtureCount: number;
  recallAtK: number;
  precisionAtK: number;
  mrr: number;
  ndcgAtK: number;
  hitRate: number;
  averageLatencyMs: number;
  latencyP50Ms: number;
  averageContextTokens: number;
}

export interface HistoricalScenarioIndicatorSummary extends HistoricalMetricSummary {
  negativeCorrectRate?: number;
}

export interface HistoricalStrategyReport {
  name: string;
  k: number;
  evaluations: HistoricalFixtureEvaluation[];
  summary: HistoricalMetricSummary;
  indicators: Partial<
    Record<"conflict" | "negative" | "temporal", HistoricalScenarioIndicatorSummary>
  >;
}

export interface HistoricalStrategyDelta {
  strategy: string;
  recallAtKDelta: number;
  precisionAtKDelta: number;
  mrrDelta: number;
  ndcgAtKDelta: number;
  hitRateDelta: number;
  averageLatencyMsDelta: number;
  latencyP50MsDelta: number;
  averageContextTokensDelta: number;
}

export interface HistoricalStrategyComparison {
  baseline: string;
  deltas: HistoricalStrategyDelta[];
}

export interface HistoricalFixtureEvaluationReport {
  k: number;
  fixtureCount: number;
  strategies: HistoricalStrategyReport[];
  comparison: HistoricalStrategyComparison;
}

export interface HistoricalFixtureEvaluationOptions {
  k?: number;
  baselineStrategy?: string;
}

const entityKinds: readonly HistoricalEntityKind[] = [
  "memory",
  "experiment",
  "artifact",
  "evidence",
];

const indicatorNames = ["conflict", "negative", "temporal"] as const;

function compareStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function entityKey(entity: HistoricalEntityReference): string {
  return `${entity.kind}:${entity.id}`;
}

function isEntityKind(value: unknown): value is HistoricalEntityKind {
  return typeof value === "string" && entityKinds.includes(value as HistoricalEntityKind);
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty string`);
  }
}

function assertNonNegativeNumber(value: unknown, label: string): asserts value is number {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    throw new Error(`${label} must be a finite non-negative number`);
  }
}

function validateExpectedIds(
  values: unknown,
  label: string,
): asserts values is readonly string[] | undefined {
  if (values === undefined) return;
  if (!Array.isArray(values)) {
    throw new Error(`${label} must be an array of non-empty strings`);
  }
  for (const value of values) {
    assertNonEmptyString(value, `${label} entry`);
  }
}

function validateScenario(scenario: unknown, fixtureId: string): void {
  if (scenario === undefined) return;
  if (typeof scenario !== "object" || scenario === null || Array.isArray(scenario)) {
    throw new Error(`fixture ${fixtureId} scenario must be an object`);
  }

  const metadata = scenario as HistoricalScenarioMetadata;
  if (metadata.id !== undefined) assertNonEmptyString(metadata.id, `fixture ${fixtureId} scenario.id`);
  if (metadata.category !== undefined) {
    assertNonEmptyString(metadata.category, `fixture ${fixtureId} scenario.category`);
  }
  if (metadata.tags !== undefined) {
    if (!Array.isArray(metadata.tags)) {
      throw new Error(`fixture ${fixtureId} scenario.tags must be an array of non-empty strings`);
    }
    for (const tag of metadata.tags) {
      assertNonEmptyString(tag, `fixture ${fixtureId} scenario.tags entry`);
    }
  }
  for (const indicator of indicatorNames) {
    if (metadata[indicator] !== undefined && typeof metadata[indicator] !== "boolean") {
      throw new Error(`fixture ${fixtureId} scenario.${indicator} must be a boolean`);
    }
  }
}

export function validateHistoricalTaskFixtures(
  fixtures: readonly HistoricalTaskFixture[],
): void {
  if (!Array.isArray(fixtures) || fixtures.length === 0) {
    throw new Error("fixtures must contain at least one fixture");
  }

  const fixtureIds = new Set<string>();
  for (const fixture of fixtures) {
    if (typeof fixture !== "object" || fixture === null) {
      throw new Error("each fixture must be an object");
    }
    assertNonEmptyString(fixture.id, "fixture id");
    if (fixtureIds.has(fixture.id)) {
      throw new Error(`duplicate fixture id: ${fixture.id}`);
    }
    fixtureIds.add(fixture.id);
    assertNonEmptyString(fixture.query, `fixture ${fixture.id} query`);
    validateExpectedIds(fixture.expectedMemoryIds, `fixture ${fixture.id} expectedMemoryIds`);
    validateExpectedIds(fixture.expectedExperimentIds, `fixture ${fixture.id} expectedExperimentIds`);
    validateExpectedIds(fixture.expectedArtifactIds, `fixture ${fixture.id} expectedArtifactIds`);
    validateExpectedIds(fixture.expectedEvidenceIds, `fixture ${fixture.id} expectedEvidenceIds`);
    validateScenario(fixture.scenario, fixture.id);
  }
}

export function expectedHistoricalEntityReferences(
  fixture: HistoricalTaskFixture,
): HistoricalEntityReference[] {
  const groups: Array<[HistoricalEntityKind, readonly string[] | undefined]> = [
    ["memory", fixture.expectedMemoryIds],
    ["experiment", fixture.expectedExperimentIds],
    ["artifact", fixture.expectedArtifactIds],
    ["evidence", fixture.expectedEvidenceIds],
  ];
  const seen = new Set<string>();
  const references: HistoricalEntityReference[] = [];

  for (const [kind, ids] of groups) {
    for (const id of ids ?? []) {
      const reference = { id, kind };
      const key = entityKey(reference);
      if (!seen.has(key)) {
        seen.add(key);
        references.push(reference);
      }
    }
  }
  return references;
}

function validateStrategyResult(result: HistoricalStrategyResult, strategyName: string): void {
  if (typeof result !== "object" || result === null || !Array.isArray(result.items)) {
    throw new Error(`strategy ${strategyName} must return an items array`);
  }
  assertNonNegativeNumber(result.latencyMs, `strategy ${strategyName} latencyMs`);
  if (result.contextTokens !== undefined) {
    assertNonNegativeNumber(result.contextTokens, `strategy ${strategyName} contextTokens`);
  }
  for (const item of result.items) {
    if (typeof item !== "object" || item === null) {
      throw new Error(`strategy ${strategyName} returned an invalid item`);
    }
    assertNonEmptyString(item.id, `strategy ${strategyName} item id`);
    if (!isEntityKind(item.kind)) {
      throw new Error(`strategy ${strategyName} item kind must be one of: ${entityKinds.join(", ")}`);
    }
    if (item.score !== undefined && (!Number.isFinite(item.score) || typeof item.score !== "number")) {
      throw new Error(`strategy ${strategyName} item score must be finite when supplied`);
    }
    if (item.context !== undefined && typeof item.context !== "string") {
      throw new Error(`strategy ${strategyName} item context must be a string when supplied`);
    }
    if (item.contextTokens !== undefined) {
      assertNonNegativeNumber(item.contextTokens, `strategy ${strategyName} item contextTokens`);
    }
  }
}

function dedupeRankedItems(items: readonly HistoricalRetrievedItem[]): HistoricalRetrievedItem[] {
  const seen = new Set<string>();
  const unique: HistoricalRetrievedItem[] = [];
  for (const item of items) {
    const key = entityKey(item);
    if (!seen.has(key)) {
      seen.add(key);
      unique.push(item);
    }
  }
  return unique;
}

export function estimateContextTokens(text: string): number {
  return text.length === 0 ? 0 : Math.ceil(text.length / 4);
}

function contextTokensFor(
  result: HistoricalStrategyResult,
  items: readonly HistoricalRetrievedItem[],
): number {
  if (result.contextTokens !== undefined) return result.contextTokens;
  return items.reduce(
    (total, item) => total + (item.contextTokens ?? estimateContextTokens(item.context ?? "")),
    0,
  );
}

function dcg(relevances: readonly boolean[]): number {
  return relevances.reduce(
    (total, relevant, index) => total + (relevant ? 1 / Math.log2(index + 2) : 0),
    0,
  );
}

function average(values: readonly number[]): number {
  return values.length === 0 ? 0 : values.reduce((total, value) => total + value, 0) / values.length;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((left, right) => left - right);
  const right = Math.floor(sorted.length / 2);
  const left = Math.ceil(sorted.length / 2) - 1;
  return (sorted[left] + sorted[right]) / 2;
}

function summarize(evaluations: readonly HistoricalFixtureEvaluation[]): HistoricalMetricSummary {
  return {
    fixtureCount: evaluations.length,
    recallAtK: average(evaluations.map((evaluation) => evaluation.metrics.recallAtK)),
    precisionAtK: average(evaluations.map((evaluation) => evaluation.metrics.precisionAtK)),
    mrr: average(evaluations.map((evaluation) => evaluation.metrics.mrr)),
    ndcgAtK: average(evaluations.map((evaluation) => evaluation.metrics.ndcgAtK)),
    hitRate: average(evaluations.map((evaluation) => (evaluation.metrics.hit ? 1 : 0))),
    averageLatencyMs: average(evaluations.map((evaluation) => evaluation.metrics.latencyMs)),
    latencyP50Ms: median(evaluations.map((evaluation) => evaluation.metrics.latencyMs)),
    averageContextTokens: average(evaluations.map((evaluation) => evaluation.metrics.contextTokens)),
  };
}

function summarizeIndicators(
  evaluations: readonly HistoricalFixtureEvaluation[],
): HistoricalStrategyReport["indicators"] {
  const summaries: HistoricalStrategyReport["indicators"] = {};
  for (const indicator of indicatorNames) {
    const marked = evaluations.filter((evaluation) => evaluation.indicators[indicator] === true);
    if (marked.length === 0) continue;
    const summary: HistoricalScenarioIndicatorSummary = summarize(marked);
    if (indicator === "negative") {
      summary.negativeCorrectRate = average(
        marked.map((evaluation) => (evaluation.indicators.negativeCorrect ? 1 : 0)),
      );
    }
    summaries[indicator] = summary;
  }
  return summaries;
}

function scenarioIndicators(
  fixture: HistoricalTaskFixture,
  metrics: HistoricalTaskMetrics,
  rankedItems: readonly HistoricalRetrievedItem[],
  k: number,
): HistoricalScenarioIndicators {
  const scenario = fixture.scenario;
  const negative = scenario?.negative;
  const noExpectedEntities = metrics.relevantCount === 0;
  return {
    conflict: scenario?.conflict,
    negative,
    temporal: scenario?.temporal,
    negativeCorrect:
      negative === true
        ? noExpectedEntities
          ? rankedItems.slice(0, k).length === 0
          : metrics.hit
        : undefined,
  };
}

function scoreFixture(
  fixture: HistoricalTaskFixture,
  strategy: string,
  result: HistoricalStrategyResult,
  k: number,
): HistoricalFixtureEvaluation {
  validateStrategyResult(result, strategy);
  const expected = expectedHistoricalEntityReferences(fixture);
  const expectedKeys = new Set(expected.map(entityKey));
  const rankedItems = dedupeRankedItems(result.items);
  const topK = rankedItems.slice(0, k);
  const relevances = topK.map((item) => expectedKeys.has(entityKey(item)));
  const hits = relevances.filter(Boolean).length;
  const topRelevantIndex = rankedItems.findIndex((item) => expectedKeys.has(entityKey(item)));
  const idealRelevances = Array.from(
    { length: Math.min(k, expectedKeys.size) },
    () => true,
  );
  const idealDcg = dcg(idealRelevances);
  const metrics: HistoricalTaskMetrics = {
    recallAtK: expectedKeys.size === 0 ? 0 : hits / expectedKeys.size,
    precisionAtK: hits / k,
    mrr: topRelevantIndex === -1 ? 0 : 1 / (topRelevantIndex + 1),
    ndcgAtK: idealDcg === 0 ? 0 : dcg(relevances) / idealDcg,
    hit: hits > 0,
    topRelevantRank: topRelevantIndex === -1 ? null : topRelevantIndex + 1,
    relevantCount: expectedKeys.size,
    retrievedCount: rankedItems.length,
    latencyMs: result.latencyMs,
    contextTokens: contextTokensFor(result, topK),
  };
  return {
    fixtureId: fixture.id,
    query: fixture.query,
    strategy,
    scenario: fixture.scenario,
    indicators: scenarioIndicators(fixture, metrics, rankedItems, k),
    metrics,
  };
}

function validateStrategies(strategies: readonly HistoricalTaskStrategy[]): void {
  if (!Array.isArray(strategies) || strategies.length === 0) {
    throw new Error("strategies must contain at least one named strategy");
  }
  const names = new Set<string>();
  for (const strategy of strategies) {
    if (typeof strategy !== "object" || strategy === null) {
      throw new Error("each strategy must be an object");
    }
    assertNonEmptyString(strategy.name, "strategy name");
    if (names.has(strategy.name)) {
      throw new Error(`duplicate strategy name: ${strategy.name}`);
    }
    names.add(strategy.name);
    if (typeof strategy.retrieve !== "function") {
      throw new Error(`strategy ${strategy.name} must provide retrieve()`);
    }
  }
}

function validateK(k: number): void {
  if (!Number.isInteger(k) || k <= 0) {
    throw new Error(`k must be a positive integer, got: ${k}`);
  }
}

export async function evaluateHistoricalTaskFixtures(
  fixtures: readonly HistoricalTaskFixture[],
  strategies: readonly HistoricalTaskStrategy[],
  options: HistoricalFixtureEvaluationOptions = {},
): Promise<HistoricalFixtureEvaluationReport> {
  validateHistoricalTaskFixtures(fixtures);
  validateStrategies(strategies);
  const k = options.k ?? 5;
  validateK(k);

  const sortedFixtures = [...fixtures].sort((left, right) => compareStrings(left.id, right.id));
  const sortedStrategies = [...strategies].sort((left, right) => compareStrings(left.name, right.name));
  const reports: HistoricalStrategyReport[] = [];

  for (const strategy of sortedStrategies) {
    const evaluations: HistoricalFixtureEvaluation[] = [];
    for (const fixture of sortedFixtures) {
      const result = await strategy.retrieve(fixture, k);
      evaluations.push(scoreFixture(fixture, strategy.name, result, k));
    }
    reports.push({
      name: strategy.name,
      k,
      evaluations,
      summary: summarize(evaluations),
      indicators: summarizeIndicators(evaluations),
    });
  }

  return {
    k,
    fixtureCount: sortedFixtures.length,
    strategies: reports,
    comparison: compareHistoricalStrategies(reports, options.baselineStrategy),
  };
}

function sameFixtureIds(
  left: readonly HistoricalFixtureEvaluation[],
  right: readonly HistoricalFixtureEvaluation[],
): boolean {
  if (left.length !== right.length) return false;
  const leftIds = left.map((evaluation) => evaluation.fixtureId).sort(compareStrings);
  const rightIds = right.map((evaluation) => evaluation.fixtureId).sort(compareStrings);
  return leftIds.every((fixtureId, index) => fixtureId === rightIds[index]);
}

export function compareHistoricalStrategies(
  reports: readonly HistoricalStrategyReport[],
  baselineStrategy?: string,
): HistoricalStrategyComparison {
  if (!Array.isArray(reports) || reports.length === 0) {
    throw new Error("reports must contain at least one strategy report");
  }
  const sortedReports = [...reports].sort((left, right) => compareStrings(left.name, right.name));
  const names = new Set<string>();
  const expectedK = sortedReports[0].k;
  const referenceEvaluations = sortedReports[0].evaluations;
  for (const report of sortedReports) {
    assertNonEmptyString(report.name, "strategy report name");
    if (names.has(report.name)) throw new Error(`duplicate strategy report name: ${report.name}`);
    names.add(report.name);
    validateK(report.k);
    if (report.k !== expectedK) {
      throw new Error("strategy reports must use the same k");
    }
    if (!sameFixtureIds(referenceEvaluations, report.evaluations)) {
      throw new Error("strategy reports must evaluate the same fixture IDs");
    }
  }

  const baselineName = baselineStrategy ?? sortedReports[0].name;
  const baseline = sortedReports.find((report) => report.name === baselineName);
  if (!baseline) throw new Error(`baseline strategy not found: ${baselineName}`);

  return {
    baseline: baseline.name,
    deltas: sortedReports.map((report) => ({
      strategy: report.name,
      recallAtKDelta: report.summary.recallAtK - baseline.summary.recallAtK,
      precisionAtKDelta: report.summary.precisionAtK - baseline.summary.precisionAtK,
      mrrDelta: report.summary.mrr - baseline.summary.mrr,
      ndcgAtKDelta: report.summary.ndcgAtK - baseline.summary.ndcgAtK,
      hitRateDelta: report.summary.hitRate - baseline.summary.hitRate,
      averageLatencyMsDelta: report.summary.averageLatencyMs - baseline.summary.averageLatencyMs,
      latencyP50MsDelta: report.summary.latencyP50Ms - baseline.summary.latencyP50Ms,
      averageContextTokensDelta:
        report.summary.averageContextTokens - baseline.summary.averageContextTokens,
    })),
  };
}

function percent(value: number): string {
  return `${(value * 100).toFixed(2)}%`;
}

function number(value: number): string {
  return value.toFixed(2);
}

function signedNumber(value: number): string {
  return `${value >= 0 ? "+" : ""}${number(value)}`;
}

function signedPercent(value: number): string {
  return `${value >= 0 ? "+" : ""}${percent(value)}`;
}

export function formatHistoricalStrategyReport(report: HistoricalFixtureEvaluationReport): string {
  const lines = [
    "# Historical Task Fixture Evaluation",
    "",
    `Fixtures: ${report.fixtureCount} | K: ${report.k} | Baseline: ${report.comparison.baseline}`,
    "",
    "## Strategy Metrics",
    "",
    `| Strategy | Recall@${report.k} | Precision@${report.k} | MRR | NDCG@${report.k} | Hit rate | Avg latency | P50 latency | Avg context tokens |`,
    "|---|---:|---:|---:|---:|---:|---:|---:|---:|",
  ];

  for (const strategy of report.strategies) {
    const summary = strategy.summary;
    lines.push(
      `| ${strategy.name} | ${percent(summary.recallAtK)} | ${percent(summary.precisionAtK)} | ${number(summary.mrr)} | ${percent(summary.ndcgAtK)} | ${percent(summary.hitRate)} | ${number(summary.averageLatencyMs)}ms | ${number(summary.latencyP50Ms)}ms | ${number(summary.averageContextTokens)} |`,
    );
  }

  lines.push("", `## Deltas vs ${report.comparison.baseline}`, "");
  lines.push(
    "| Strategy | Recall | Precision | MRR | NDCG | Hit rate | Avg latency | P50 latency | Context tokens |",
  );
  lines.push("|---|---:|---:|---:|---:|---:|---:|---:|---:|");
  for (const delta of report.comparison.deltas) {
    lines.push(
      `| ${delta.strategy} | ${signedPercent(delta.recallAtKDelta)} | ${signedPercent(delta.precisionAtKDelta)} | ${signedNumber(delta.mrrDelta)} | ${signedPercent(delta.ndcgAtKDelta)} | ${signedPercent(delta.hitRateDelta)} | ${signedNumber(delta.averageLatencyMsDelta)}ms | ${signedNumber(delta.latencyP50MsDelta)}ms | ${signedNumber(delta.averageContextTokensDelta)} |`,
    );
  }

  const indicatorRows = report.strategies.flatMap((strategy) =>
    indicatorNames.flatMap((indicator) => {
      const summary = strategy.indicators[indicator];
      return summary ? [{ strategy: strategy.name, indicator, summary }] : [];
    }),
  );
  if (indicatorRows.length > 0) {
    lines.push("", "## Scenario Indicators", "");
    lines.push(
      `| Strategy | Indicator | Fixtures | Recall@${report.k} | Precision@${report.k} | MRR | NDCG@${report.k} | Hit rate | Negative correct |`,
    );
    lines.push("|---|---|---:|---:|---:|---:|---:|---:|---:|");
    for (const row of indicatorRows) {
      const negativeCorrect =
        row.summary.negativeCorrectRate === undefined
          ? "-"
          : percent(row.summary.negativeCorrectRate);
      lines.push(
        `| ${row.strategy} | ${row.indicator} | ${row.summary.fixtureCount} | ${percent(row.summary.recallAtK)} | ${percent(row.summary.precisionAtK)} | ${number(row.summary.mrr)} | ${percent(row.summary.ndcgAtK)} | ${percent(row.summary.hitRate)} | ${negativeCorrect} |`,
      );
    }
  }

  return lines.join("\n");
}
