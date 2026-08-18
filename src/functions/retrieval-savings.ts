import type {
  StateKVJsonAggregateRequest,
  StateKVJsonAggregateResult,
  StateKVJsonFilter,
} from "../state/backend-kv.js";
import { StateKV } from "../state/kv.js";
import { KV } from "../state/schema.js";
import type {
  ContextReductionSourceStats,
  RetrievalSavingsCorpus,
  RetrievalSavingsPricing,
  RetrievalSavingsPricingRates,
  RetrievalSavingsRateClass,
  RetrievalSavingsStats,
  Session,
} from "../types.js";
import {
  estimateContextTokensFromChars,
  TOKEN_ESTIMATOR,
} from "../utils/token-estimate.js";
import {
  inspectManagedImages,
  type ImageInventory,
} from "../utils/image-dimensions.js";

const GPT_5_6_SOL_SOURCE = "https://developers.openai.com/api/docs/pricing";
const GPT_5_6_SOL_VERIFIED_AT = "2026-07-18";
const GPT_5_6_SOL_CONTEXT_WINDOW = 1_050_000;
const GPT_5_6_SOL_LONG_CONTEXT_THRESHOLD = 272_000;
const RETRIEVAL_CORPUS_CACHE_TTL_MS = 60_000;

const GPT_5_6_SOL_STANDARD_RATES: RetrievalSavingsPricingRates = {
  input: 5,
  cachedInput: 0.5,
  cacheWrite: 6.25,
  output: 30,
};

const GPT_5_6_SOL_LONG_RATES: RetrievalSavingsPricingRates = {
  input: 10,
  cachedInput: 1,
  cacheWrite: 12.5,
  output: 45,
};

export interface RetrievalSavingsCalculatorOptions {
  cacheTtlMs?: number;
  now?: () => Date;
  inspectImages?: (imageRefs?: string[]) => Promise<ImageInventory>;
}

interface CachedCorpus {
  expiresAt: number;
  value: RetrievalSavingsCorpus;
}

function normalizeProject(project?: string): string | undefined {
  return typeof project === "string" && project.trim() ? project.trim() : undefined;
}

function matchesFallbackFilter(
  value: unknown,
  filter: NonNullable<StateKVJsonAggregateRequest["filters"]>[number],
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const hasField = Object.prototype.hasOwnProperty.call(record, filter.field);
  if (filter.operator === "exists") return hasField;
  if (filter.operator === "equals_or_missing") {
    return !hasField || record[filter.field] === filter.value;
  }
  if (filter.operator === "equals") return record[filter.field] === filter.value;
  return record[filter.field] !== filter.value;
}

async function aggregateJson(
  kv: StateKV,
  request: StateKVJsonAggregateRequest,
): Promise<StateKVJsonAggregateResult> {
  const backendAggregate = (
    kv as StateKV & {
      aggregateJson?: (
        input: StateKVJsonAggregateRequest,
      ) => Promise<StateKVJsonAggregateResult>;
    }
  ).aggregateJson;
  if (typeof backendAggregate === "function") return backendAggregate.call(kv, request);

  const stringSets = new Map<string, Set<string>>(
    (request.collectStringFields ?? []).map((field) => [field, new Set()]),
  );
  let count = 0;
  let serializedChars = 0;
  for (const scope of [...new Set(request.scopes)]) {
    const values = await kv.list<unknown>(scope);
    for (const value of values) {
      if (!(request.filters ?? []).every((filter) => matchesFallbackFilter(value, filter))) {
        continue;
      }
      count++;
      serializedChars += JSON.stringify(value)?.length ?? 0;
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const record = value as Record<string, unknown>;
      for (const [field, set] of stringSets) {
        if (typeof record[field] === "string" && record[field]) set.add(record[field]);
      }
    }
  }
  return {
    count,
    serializedChars,
    stringValues: Object.fromEntries(
      [...stringSets].map(([field, values]) => [field, [...values]]),
    ),
  };
}

function selectedRates(rateClass: RetrievalSavingsRateClass): RetrievalSavingsPricingRates {
  return rateClass === "long"
    ? GPT_5_6_SOL_LONG_RATES
    : GPT_5_6_SOL_STANDARD_RATES;
}

function usdForTokens(tokens: number, dollarsPerMillionTokens: number): number {
  if (tokens <= 0) return 0;
  return Number(((tokens / 1_000_000) * dollarsPerMillionTokens).toFixed(6));
}

function pricingFor(totalTokens: number): RetrievalSavingsPricing {
  const rateClass: RetrievalSavingsRateClass =
    totalTokens > GPT_5_6_SOL_LONG_CONTEXT_THRESHOLD ? "long" : "short";
  return {
    model: "gpt-5.6-sol",
    tier: "standard",
    currency: "USD",
    standardRatesPerMillionTokens: GPT_5_6_SOL_STANDARD_RATES,
    rateClass,
    ratesPerMillionTokens: selectedRates(rateClass),
    longContextThresholdTokens: GPT_5_6_SOL_LONG_CONTEXT_THRESHOLD,
    contextWindowTokens: GPT_5_6_SOL_CONTEXT_WINDOW,
    source: GPT_5_6_SOL_SOURCE,
    verifiedAt: GPT_5_6_SOL_VERIFIED_AT,
  };
}

function buildAssumptions(
  corpus: RetrievalSavingsCorpus,
  pricing: RetrievalSavingsPricing,
): string[] {
  const assumptions = [
    "Corpus includes compressed observations with a narrative, latest memories, non-deleted lessons, and unique managed image files.",
    `Serialized memory values use ${TOKEN_ESTIMATOR} (${corpus.textChars.toLocaleString()} characters ÷ 3); this is an estimate, not a tokenizer measurement.`,
    "GPT-5.6 Sol image tokens use original/auto mode: ceil(width ÷ 32) × ceil(height ÷ 32); images with unreadable headers are counted but contribute zero estimated image tokens.",
    "MCP vision results expose image references/metadata, not host image-view pixels, so delivered image tokens are recorded as zero unless a host reports them separately.",
    "Each explicit MCP recall/search event is treated as one opportunity where a full retrievable corpus could otherwise have been loaded; this is a counterfactual, not host-reported billing.",
    "Only input-token equivalents are included; output tokens, embeddings, compression calls, and MCP transport overhead are not claimed as savings.",
  ];
  if (corpus.exceedsContextWindow) {
    assumptions.push(
      `The corpus exceeds the ${pricing.contextWindowTokens.toLocaleString()}-token context window, so a full load is a batched equivalent rather than one feasible request.`,
    );
  }
  if (pricing.rateClass === "long") {
    assumptions.push(
      `The displayed full-corpus costs use GPT-5.6 Sol's >${pricing.longContextThresholdTokens.toLocaleString()}-input-token rate class for each hypothetical large batch.`,
    );
  }
  return assumptions;
}

export function buildRetrievalSavingsStats(
  corpus: RetrievalSavingsCorpus,
  delivery: Pick<ContextReductionSourceStats, "measuredEvents" | "returnedTokens">,
): RetrievalSavingsStats {
  const pricing = pricingFor(corpus.totalTokens);
  const rates = pricing.ratesPerMillionTokens;
  const events = Math.max(0, Math.floor(delivery.measuredEvents));
  const textTokensDelivered = Math.max(0, Math.floor(delivery.returnedTokens));
  const imageTokensDelivered = 0;
  const fullLoadTokens = Math.max(0, corpus.totalTokens);
  const potentialTokens = fullLoadTokens * events;
  const estimatedTokensAvoided = Math.max(
    0,
    potentialTokens - textTokensDelivered - imageTokensDelivered,
  );
  const avoidedPercent =
    potentialTokens > 0
      ? Number(((estimatedTokensAvoided / potentialTokens) * 100).toFixed(1))
      : null;
  const perFullCorpusLoad = {
    cachedReadUsd: usdForTokens(fullLoadTokens, rates.cachedInput),
    uncachedInputUsd: usdForTokens(fullLoadTokens, rates.input),
    cacheWriteUsd: usdForTokens(fullLoadTokens, rates.cacheWrite),
    rateClass: pricing.rateClass,
    isBatchedCounterfactual: corpus.exceedsContextWindow,
  };
  return {
    corpus,
    delivery: {
      events,
      textTokensDelivered,
      imageTokensDelivered,
    },
    pricing,
    perFullCorpusLoad,
    totalAcrossMcpCalls: {
      estimatedTokensAvoided,
      cachedReadUsd: usdForTokens(estimatedTokensAvoided, rates.cachedInput),
      uncachedInputUsd: usdForTokens(estimatedTokensAvoided, rates.input),
      cacheWriteUsd: usdForTokens(estimatedTokensAvoided, rates.cacheWrite),
      avoidedPercent,
    },
    assumptions: buildAssumptions(corpus, pricing),
  };
}

export function createRetrievalSavingsCalculator(
  kv: StateKV,
  options: RetrievalSavingsCalculatorOptions = {},
): (project?: string) => Promise<RetrievalSavingsCorpus> {
  const cache = new Map<string, CachedCorpus>();
  const inFlight = new Map<string, Promise<RetrievalSavingsCorpus>>();
  const ttlMs = Math.max(0, options.cacheTtlMs ?? RETRIEVAL_CORPUS_CACHE_TTL_MS);
  const now = options.now ?? (() => new Date());
  const inspectImages = options.inspectImages ?? inspectManagedImages;

  const calculate = async (project?: string): Promise<RetrievalSavingsCorpus> => {
    const normalizedProject = normalizeProject(project);
    const cacheKey = normalizedProject ?? "*";
    const timestamp = Date.now();
    const cached = cache.get(cacheKey);
    if (cached && cached.expiresAt > timestamp) return cached.value;
    const pending = inFlight.get(cacheKey);
    if (pending) return pending;

    const work = (async () => {
      const sessions = await kv.list<Session>(KV.sessions);
      const eligibleSessions = normalizedProject
        ? sessions.filter((session) => session.project === normalizedProject)
        : sessions;
      const observationScopes = eligibleSessions.map((session) => KV.observations(session.id));
      const observationRequest: StateKVJsonAggregateRequest = {
        scopes: observationScopes,
        filters: [{ field: "narrative", operator: "exists" }],
        ...(normalizedProject ? { collectStringFields: ["imageRef"] } : {}),
      };
      const memoryFilters: StateKVJsonFilter[] = [
        { field: "isLatest", operator: "equals", value: true },
      ];
      if (normalizedProject) {
        memoryFilters.push({
          field: "project",
          operator: "equals_or_missing",
          value: normalizedProject,
        });
      }
      const memoryRequest: StateKVJsonAggregateRequest = {
        scopes: [KV.memories],
        filters: memoryFilters,
        ...(normalizedProject ? { collectStringFields: ["imageRef"] } : {}),
      };
      const lessonFilters: StateKVJsonFilter[] = [
        { field: "deleted", operator: "not_equals", value: true },
      ];
      if (normalizedProject) {
        lessonFilters.push({
          field: "project",
          operator: "equals",
          value: normalizedProject,
        });
      }
      const lessonRequest: StateKVJsonAggregateRequest = {
        scopes: [KV.lessons],
        filters: lessonFilters,
      };
      const [observations, memories, lessons] = await Promise.all([
        aggregateJson(kv, observationRequest),
        aggregateJson(kv, memoryRequest),
        aggregateJson(kv, lessonRequest),
      ]);
      const imageRefs = normalizedProject
        ? [
            ...(observations.stringValues.imageRef ?? []),
            ...(memories.stringValues.imageRef ?? []),
          ]
        : undefined;
      const images = await inspectImages(imageRefs);
      const textChars =
        observations.serializedChars + memories.serializedChars + lessons.serializedChars;
      const textTokens = estimateContextTokensFromChars(textChars);
      const totalTokens = textTokens + images.imageTokens;
      const value: RetrievalSavingsCorpus = {
        textChars,
        textTokens,
        imageCount: images.imageCount,
        imageBytes: images.imageBytes,
        imageTokens: images.imageTokens,
        unknownImageCount: images.unknownImageCount,
        totalTokens,
        observationCount: observations.count,
        memoryCount: memories.count,
        lessonCount: lessons.count,
        calculatedAt: now().toISOString(),
        exceedsLongContextThreshold: totalTokens > GPT_5_6_SOL_LONG_CONTEXT_THRESHOLD,
        exceedsContextWindow: totalTokens > GPT_5_6_SOL_CONTEXT_WINDOW,
      };
      cache.set(cacheKey, { expiresAt: Date.now() + ttlMs, value });
      return value;
    })();
    inFlight.set(cacheKey, work);
    try {
      return await work;
    } finally {
      inFlight.delete(cacheKey);
    }
  };

  return calculate;
}

export const RETRIEVAL_SAVINGS_CONSTANTS = {
  contextWindowTokens: GPT_5_6_SOL_CONTEXT_WINDOW,
  longContextThresholdTokens: GPT_5_6_SOL_LONG_CONTEXT_THRESHOLD,
  standardRatesPerMillionTokens: GPT_5_6_SOL_STANDARD_RATES,
  longRatesPerMillionTokens: GPT_5_6_SOL_LONG_RATES,
  source: GPT_5_6_SOL_SOURCE,
};
