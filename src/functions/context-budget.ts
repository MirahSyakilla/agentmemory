import { estimateContextTokens } from "../utils/token-estimate.js";

export type ContextTier =
  | "direct"
  | "supporting"
  | "historical"
  | "provenance";

export const CONTEXT_TIERS: readonly ContextTier[] = [
  "direct",
  "supporting",
  "historical",
  "provenance",
];

export interface ContextBudgets {
  total: number;
  direct: number;
  supporting: number;
  historical: number;
  provenance: number;
}

export type ContextBudgetInput = Partial<ContextBudgets>;

export const DEFAULT_CONTEXT_BUDGETS: ContextBudgets = {
  total: 4_000,
  direct: 2_000,
  supporting: 1_000,
  historical: 600,
  provenance: 400,
};

export interface ContextBudgetItem {
  id: string;
  tier: ContextTier;
  text: string;
  title?: string;
  preview?: string;
  score?: number;
  source?: string;
  tokenCost?: number;
  expandable?: boolean;
  metadata?: Record<string, unknown>;
}

export interface ContextEntry {
  id: string;
  tier: ContextTier;
  content: string;
  title?: string;
  tokens: number;
  score?: number;
  source?: string;
  expandHandle?: string;
  metadata?: Record<string, unknown>;
}

export interface ExpandableContextHandle {
  handle: string;
  itemId: string;
  tier: ContextTier;
  preview: string;
  fullTokens: number;
  source?: string;
}

export interface ContextBudgetDiagnostics {
  itemCounts: Record<ContextTier, number>;
  returnedCounts: Record<ContextTier, number>;
  omittedCounts: Record<ContextTier, number>;
  usedTokens: Record<ContextTier, number>;
  truncated: boolean;
}

export interface TieredContext {
  budgets: ContextBudgets;
  tiers: Record<ContextTier, ContextEntry[]>;
  handles: ExpandableContextHandle[];
  omitted: Record<ContextTier, string[]>;
  tokensUsed: number;
  truncated: boolean;
  diagnostics: ContextBudgetDiagnostics;
}

export interface ExpandedContext {
  itemId: string;
  tier: ContextTier;
  content: string;
  tokensUsed: number;
  fullTokens: number;
  truncated: boolean;
}

const TIER_WEIGHTS: Record<ContextTier, number> = {
  direct: 0.5,
  supporting: 0.25,
  historical: 0.15,
  provenance: 0.1,
};

function compareText(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function nonNegativeInteger(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined;
  return Math.max(0, Math.floor(value));
}

function allocateWeighted(total: number): Record<ContextTier, number> {
  const values = {} as Record<ContextTier, number>;
  let allocated = 0;
  for (const tier of CONTEXT_TIERS) {
    values[tier] = Math.floor(total * TIER_WEIGHTS[tier]);
    allocated += values[tier];
  }
  values.direct += total - allocated;
  return values;
}

export function resolveContextBudgets(
  input: ContextBudgetInput = {},
): ContextBudgets {
  const explicit = CONTEXT_TIERS.filter((tier) =>
    nonNegativeInteger(input[tier]) !== undefined,
  );
  const requestedTotal = nonNegativeInteger(input.total);

  if (explicit.length === 0 && requestedTotal === undefined) {
    return { ...DEFAULT_CONTEXT_BUDGETS };
  }

  if (explicit.length === 0) {
    const total = requestedTotal!;
    const weighted = allocateWeighted(total);
    return { total, ...weighted };
  }

  const tierValues = {} as Record<ContextTier, number>;
  let explicitSum = 0;
  for (const tier of CONTEXT_TIERS) {
    const value = nonNegativeInteger(input[tier]);
    tierValues[tier] = value ?? 0;
    explicitSum += tierValues[tier];
  }

  if (requestedTotal === undefined) {
    return { total: explicitSum, ...tierValues };
  }

  const total = Math.max(requestedTotal, explicitSum);
  const missing = CONTEXT_TIERS.filter((tier) => !explicit.includes(tier));
  const remaining = Math.max(0, total - explicitSum);
  if (missing.length > 0 && remaining > 0) {
    const missingWeight = missing.reduce(
      (sum, tier) => sum + TIER_WEIGHTS[tier],
      0,
    );
    let allocated = 0;
    for (const tier of missing) {
      const value = Math.floor(
        (remaining * TIER_WEIGHTS[tier]) / missingWeight,
      );
      tierValues[tier] = value;
      allocated += value;
    }
    tierValues[missing[0]] += remaining - allocated;
  }
  return { total, ...tierValues };
}

function scoreForSort(item: ContextBudgetItem): number {
  return typeof item.score === "number" && Number.isFinite(item.score)
    ? item.score
    : 0;
}

function sortItems(items: ContextBudgetItem[]): ContextBudgetItem[] {
  return items.slice().sort((a, b) => {
    const scoreDelta = scoreForSort(b) - scoreForSort(a);
    return scoreDelta || compareText(a.id, b.id);
  });
}

function clippedPreview(text: string, maxChars = 240): string {
  if (maxChars <= 0) return "";
  if (text.length <= maxChars) return text;
  if (maxChars <= 3) return text.slice(0, maxChars);
  return `${text.slice(0, Math.max(0, maxChars - 3))}...`;
}

function handleFor(item: ContextBudgetItem): string {
  return `ctx:${item.tier}:${item.id}`;
}

function makeHandle(item: ContextBudgetItem): ExpandableContextHandle {
  return {
    handle: handleFor(item),
    itemId: item.id,
    tier: item.tier,
    preview: clippedPreview(item.preview ?? item.text),
    fullTokens: estimateContextTokens(item.text),
    ...(item.source ? { source: item.source } : {}),
  };
}

function emptyTierRecord<T>(factory: () => T): Record<ContextTier, T> {
  return {
    direct: factory(),
    supporting: factory(),
    historical: factory(),
    provenance: factory(),
  };
}

export function partitionContext(
  items: ContextBudgetItem[],
  budgetInput: ContextBudgetInput = {},
): TieredContext {
  const budgets = resolveContextBudgets(budgetInput);
  const byTier = emptyTierRecord<ContextBudgetItem[]>(() => []);
  const unique = new Map<string, ContextBudgetItem>();
  for (const item of items) {
    if (!item.id || unique.has(item.id)) continue;
    unique.set(item.id, item);
  }
  for (const item of unique.values()) byTier[item.tier].push(item);

  const tiers = emptyTierRecord<ContextEntry[]>(() => []);
  const omitted = emptyTierRecord<string[]>(() => []);
  const usedTokens = emptyTierRecord<number>(() => 0);
  const itemCounts = emptyTierRecord<number>(() => 0);
  const returnedCounts = emptyTierRecord<number>(() => 0);
  const omittedCounts = emptyTierRecord<number>(() => 0);
  const handles: ExpandableContextHandle[] = [];
  let remainingTotal = budgets.total;

  for (const tier of CONTEXT_TIERS) {
    const ordered = sortItems(byTier[tier]);
    itemCounts[tier] = ordered.length;
    for (const item of ordered) {
      const content = item.preview ?? item.text;
      const tokens =
        item.tokenCost !== undefined
          ? Math.max(0, Math.floor(item.tokenCost))
          : estimateContextTokens(content);
      const fits =
        tokens <= budgets[tier] - usedTokens[tier] &&
        tokens <= remainingTotal;
      if (!fits) {
        omitted[tier].push(item.id);
        omittedCounts[tier]++;
        handles.push(makeHandle(item));
        continue;
      }

      usedTokens[tier] += tokens;
      remainingTotal -= tokens;
      const expandable = item.expandable !== false;
      const entry: ContextEntry = {
        id: item.id,
        tier,
        content,
        ...(item.title ? { title: item.title } : {}),
        tokens,
        ...(item.score !== undefined ? { score: item.score } : {}),
        ...(item.source ? { source: item.source } : {}),
        ...(expandable ? { expandHandle: handleFor(item) } : {}),
        ...(item.metadata ? { metadata: item.metadata } : {}),
      };
      tiers[tier].push(entry);
      returnedCounts[tier]++;
      if (expandable) handles.push(makeHandle(item));
    }
  }

  const tokensUsed = CONTEXT_TIERS.reduce(
    (sum, tier) => sum + usedTokens[tier],
    0,
  );
  return {
    budgets,
    tiers,
    handles,
    omitted,
    tokensUsed,
    truncated: CONTEXT_TIERS.some((tier) => omitted[tier].length > 0),
    diagnostics: {
      itemCounts,
      returnedCounts,
      omittedCounts,
      usedTokens,
      truncated: CONTEXT_TIERS.some((tier) => omitted[tier].length > 0),
    },
  };
}

export function expandContextHandle(
  handle: ExpandableContextHandle,
  items: ContextBudgetItem[],
  tokenBudget?: number,
): ExpandedContext | null {
  if (handle.handle !== `ctx:${handle.tier}:${handle.itemId}`) return null;
  const item = items.find(
    (candidate) =>
      candidate.id === handle.itemId && candidate.tier === handle.tier,
  );
  if (!item) return null;

  const fullTokens = estimateContextTokens(item.text);
  const requestedBudget = nonNegativeInteger(tokenBudget);
  if (requestedBudget === undefined || fullTokens <= requestedBudget) {
    return {
      itemId: item.id,
      tier: item.tier,
      content: item.text,
      tokensUsed: fullTokens,
      fullTokens,
      truncated: false,
    };
  }

  const previewBudget = Math.max(0, requestedBudget * 3);
  const content = clippedPreview(item.preview ?? item.text, previewBudget);
  return {
    itemId: item.id,
    tier: item.tier,
    content,
    tokensUsed: estimateContextTokens(content),
    fullTokens,
    truncated: content !== item.text,
  };
}
