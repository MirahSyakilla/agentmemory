import type { ContextReductionAccounting } from "../types.js";
import { generateId } from "../state/schema.js";

export const TOKEN_ESTIMATOR = "chars_div_3_v1";

export function estimateContextTokensFromChars(chars: number): number {
  return chars <= 0 ? 0 : Math.ceil(chars / 3);
}

export function estimateContextTokens(text: string): number {
  return estimateContextTokensFromChars(text.length);
}

export function createContextReductionAccounting(
  baselineText: string,
  returnedText: string,
): ContextReductionAccounting {
  const baselineTokens = estimateContextTokens(baselineText);
  const returnedTokens = estimateContextTokens(returnedText);
  return {
    eventId: generateId("ctxred"),
    estimator: TOKEN_ESTIMATOR,
    baselineTokens,
    returnedTokens,
    tokenDelta: baselineTokens - returnedTokens,
  };
}

/**
 * Records text deliberately delivered through an explicit retrieval call.
 * The zero-token baseline is intentional: unlike a bounded automatic
 * injection, an MCP response is additional model-visible context rather than
 * a replacement for an existing transcript.
 */
export function createContextDeliveryAccounting(
  returnedText: string,
): ContextReductionAccounting {
  const returnedTokens = estimateContextTokens(returnedText);
  return {
    eventId: generateId("ctxred"),
    estimator: TOKEN_ESTIMATOR,
    baselineTokens: 0,
    returnedTokens,
    tokenDelta: -returnedTokens,
  };
}
