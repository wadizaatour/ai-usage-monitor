import type { CostBreakdown, ContextWindow, TokenUsage } from "./types.js";
import { lookupPricing, type ModelPricing } from "./pricing.js";

const PER_MTOK = 1_000_000;

/**
 * Compute cost from reported tokens and verified rates.
 *
 * Returns undefined — meaning the UI shows "Unavailable" — whenever the number
 * would be a guess rather than a total:
 *
 *   - the model has no verified pricing;
 *   - no token counts were reported at all;
 *   - a token class was reported with a non-zero count but its rate is not
 *     verified for that model (e.g. cache reads on a model whose cache rate we
 *     do not have).
 *
 * That last case is the subtle one. Pricing only part of a request would
 * produce a number that is real-looking, always too low, and indistinguishable
 * from a genuine total. A partial total is worse than none, so it is not shown.
 *
 * `usage.inputTokens` is assumed exclusive of `cachedTokens` per the contract in
 * types.ts, so the two are billed separately and never overlap.
 */
export function computeCost(
  model: string,
  usage: TokenUsage,
  custom?: Record<string, ModelPricing | undefined>,
): CostBreakdown | undefined {
  const found = lookupPricing(model, custom);
  if (!found) {
    return undefined;
  }
  const { pricing, source } = found;

  const input = positive(usage.inputTokens);
  const output = positive(usage.outputTokens);
  const cacheRead = positive(usage.cachedTokens);
  const cacheWrite = positive(usage.cacheWriteTokens);

  if (input === undefined && output === undefined && cacheRead === undefined && cacheWrite === undefined) {
    return undefined;
  }

  // A billable count we cannot price makes the whole total incomplete.
  if (cacheRead && pricing.cacheReadPerMTok === undefined) {
    return undefined;
  }
  if (cacheWrite && pricing.cacheWritePerMTok === undefined) {
    return undefined;
  }

  const inputUsd = rate(input, pricing.inputPerMTok);
  const outputUsd = rate(output, pricing.outputPerMTok);
  const cachedUsd =
    rate(cacheRead, pricing.cacheReadPerMTok) + rate(cacheWrite, pricing.cacheWritePerMTok);

  return {
    inputUsd,
    outputUsd,
    cachedUsd,
    totalUsd: inputUsd + outputUsd + cachedUsd,
    pricingSource: source,
  };
}

/**
 * Context-window occupancy for the turn: everything that was in the window,
 * which includes cached input (it occupies the window even though it is billed
 * at a discount) but not cache writes (those are the same tokens counted again).
 *
 * Returns undefined when the window size for the model is unknown, rather than
 * assuming a common size — a gauge against a guessed denominator is a wrong
 * percentage presented as a fact.
 */
export function computeContextWindow(
  model: string,
  usage: TokenUsage,
  custom?: Record<string, ModelPricing | undefined>,
): ContextWindow | undefined {
  const limit = lookupPricing(model, custom)?.pricing.contextWindow;
  if (limit === undefined) {
    return undefined;
  }

  const parts = [usage.inputTokens, usage.cachedTokens, usage.outputTokens].filter(
    (n): n is number => typeof n === "number" && Number.isFinite(n) && n >= 0,
  );
  if (parts.length === 0) {
    return undefined;
  }

  return { used: parts.reduce((a, b) => a + b, 0), limit };
}

/** Non-zero, finite, non-negative count — or undefined. */
function positive(n: number | undefined): number | undefined {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : undefined;
}

function rate(tokens: number | undefined, perMTok: number | undefined): number {
  if (tokens === undefined || perMTok === undefined) {
    return 0;
  }
  return (tokens / PER_MTOK) * perMTok;
}
