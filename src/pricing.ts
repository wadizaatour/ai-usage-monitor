/**
 * Verified pricing and context windows.
 *
 * Two hard rules, both of which exist because the UI labels this number "cost":
 *
 * 1. Every rate in BUILTIN_PRICING is copied from published first-party pricing,
 *    not inferred from a sibling model. `verifiedOn` records when it was last
 *    checked against the source, so a stale table is visible rather than silent.
 * 2. A model that is not in this table, or a token class whose rate is missing
 *    from its entry, produces no cost at all. `computeCost` returns undefined and
 *    the view renders "Unavailable". It never falls back to a nearby model's rate.
 *
 * Rule 2 is why `cacheReadPerMTok` and `cacheWritePerMTok` are optional rather
 * than defaulted: a request that read from cache on a model whose cache rate we
 * cannot verify has an unknown cost, and saying so beats a plausible wrong number.
 */

/** USD per 1M tokens. Absent fields mean "not verified", never "zero". */
export interface ModelPricing {
  inputPerMTok: number;
  outputPerMTok: number;
  /** Tokens served from a prompt cache. */
  cacheReadPerMTok?: number;
  /** Tokens written into a prompt cache (5-minute TTL). */
  cacheWritePerMTok?: number;
  /** Max input tokens, used for the context-window gauge. */
  contextWindow?: number;
}

interface BuiltinPricing extends ModelPricing {
  /** ISO date this row was last reconciled with published pricing. */
  verifiedOn: string;
}

/**
 * Anthropic first-party API rates. These also apply to Claude on Microsoft
 * Foundry. Bedrock and Vertex AI are partner-operated and priced separately, so
 * a Bedrock model id resolves to no built-in entry by design — configure
 * `aiUsageMonitor.pricing.custom` with your negotiated partner rates instead.
 *
 * Cache columns: reads are 0.1x input and 5-minute writes are 1.25x input across
 * this generation, with one deliberate exception — claude-fable-5-1 reads at a
 * published flat $0.25/MTok rather than the $1.00 the multiplier would give.
 * That exception is the reason each row carries explicit numbers instead of the
 * table computing them from `inputPerMTok`.
 *
 * Omitted on purpose: claude-mythos-5-1. Its cache read rate was still
 * unannounced at launch, and rules 1 and 2 above say an unverified rate is not
 * a rate. Add it via `pricing.custom` once you have the number.
 */
export const BUILTIN_PRICING: Readonly<Record<string, BuiltinPricing>> = {
  "claude-fable-5-1": {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 0.25,
    cacheWritePerMTok: 12.5,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-fable-5": {
    inputPerMTok: 10,
    outputPerMTok: 50,
    cacheReadPerMTok: 1,
    cacheWritePerMTok: 12.5,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-opus-5": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-opus-4-8": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-opus-4-7": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-opus-4-6": {
    inputPerMTok: 5,
    outputPerMTok: 25,
    cacheReadPerMTok: 0.5,
    cacheWritePerMTok: 6.25,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-sonnet-5": {
    inputPerMTok: 2,
    outputPerMTok: 10,
    cacheReadPerMTok: 0.2,
    cacheWritePerMTok: 2.5,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-sonnet-4-6": {
    inputPerMTok: 3,
    outputPerMTok: 15,
    cacheReadPerMTok: 0.3,
    cacheWritePerMTok: 3.75,
    contextWindow: 1_000_000,
    verifiedOn: "2026-06-24",
  },
  "claude-haiku-4-5": {
    inputPerMTok: 1,
    outputPerMTok: 5,
    cacheReadPerMTok: 0.1,
    cacheWritePerMTok: 1.25,
    contextWindow: 200_000,
    verifiedOn: "2026-06-24",
  },
};

/**
 * Reduce a deployment-specific model id to the plain first-party id.
 *
 * The same model arrives under four spellings depending on how it was called:
 *   claude-opus-5                       first-party
 *   anthropic.claude-opus-5             Bedrock
 *   us.anthropic.claude-opus-5-v1:0     Bedrock inference profile
 *   claude-opus-4-5@20251101            Vertex
 *   claude-opus-4-5-20251101            dated snapshot
 *
 * Only the shape is normalized here. Whether the resulting id has a verified
 * rate is still `lookupPricing`'s call — notably, a Bedrock id normalizes to a
 * first-party id whose first-party rates do not apply to a Bedrock bill, which
 * is why `normalizeModelId` reports the platform it stripped.
 */
export function normalizeModelId(model: string): {
  id: string;
  /** Set when the raw id named a partner platform whose pricing differs. */
  partnerPlatform?: "bedrock" | "vertex";
} {
  let id = model.trim();
  let partnerPlatform: "bedrock" | "vertex" | undefined;

  // Bedrock: optional region prefix, then a vendor prefix, then an optional
  // ":0"-style version tail.
  const bedrock = /^(?:[a-z]{2}(?:-[a-z]+)*\.)?anthropic\.(.+?)(?:-v\d+:\d+)?$/.exec(id);
  if (bedrock) {
    id = bedrock[1];
    partnerPlatform = "bedrock";
  }

  // Vertex uses "@" to separate the snapshot date.
  const at = id.indexOf("@");
  if (at > 0) {
    id = id.slice(0, at);
    partnerPlatform = partnerPlatform ?? "vertex";
  }

  // Dated snapshot suffix: exactly 8 trailing digits behind a dash.
  id = id.replace(/-\d{8}$/, "");

  return partnerPlatform ? { id, partnerPlatform } : { id };
}

export interface PricingLookup {
  pricing: ModelPricing;
  source: "builtin-verified" | "user-configured";
}

/**
 * Resolve rates for a model. User-configured pricing always wins, including
 * over a built-in entry, so a negotiated or partner rate can correct the table
 * without editing it.
 */
export function lookupPricing(
  model: string,
  custom?: Record<string, ModelPricing | undefined>,
): PricingLookup | undefined {
  const raw = model.trim();
  const { id, partnerPlatform } = normalizeModelId(raw);

  // Exact user key first: it is the only way to price a partner deployment, and
  // the user may key it either way.
  for (const key of [raw, id]) {
    const entry = custom?.[key];
    if (isValidPricing(entry)) {
      return { pricing: entry, source: "user-configured" };
    }
  }

  // First-party rates are wrong for a partner bill, so a Bedrock or Vertex id
  // that the user has not priced gets no cost rather than a misleading one.
  if (partnerPlatform) {
    return undefined;
  }

  const builtin = BUILTIN_PRICING[id];
  return builtin ? { pricing: builtin, source: "builtin-verified" } : undefined;
}

/**
 * Convert the user-facing settings shape into `ModelPricing`.
 *
 * The settings key documented in package.json is deliberately terser than the
 * internal type — `{ input, output, cachedInput, cacheWrite, contextWindow }`,
 * all USD per 1M tokens. This is the only place the two vocabularies meet;
 * everything downstream sees `ModelPricing`.
 *
 * A malformed entry is dropped rather than partially honored, so a typo falls
 * back to the verified table (or to no cost) instead of pricing a request at a
 * number the user did not mean.
 */
export function parseCustomPricing(
  raw: unknown,
  onInvalid?: (model: string) => void,
): Record<string, ModelPricing> {
  const result: Record<string, ModelPricing> = {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return result;
  }

  for (const [model, value] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof value !== "object" || value === null) {
      onInvalid?.(model);
      continue;
    }
    const v = value as Record<string, unknown>;
    const candidate = {
      inputPerMTok: v.input,
      outputPerMTok: v.output,
      cacheReadPerMTok: v.cachedInput,
      cacheWritePerMTok: v.cacheWrite,
      contextWindow: v.contextWindow,
    };
    if (isValidPricing(candidate)) {
      result[model] = candidate;
    } else {
      onInvalid?.(model);
    }
  }

  return result;
}

function isValidPricing(value: unknown): value is ModelPricing {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const p = value as Record<string, unknown>;
  const rate = (v: unknown): boolean => typeof v === "number" && Number.isFinite(v) && v >= 0;
  const optionalRate = (v: unknown): boolean => v === undefined || rate(v);
  return (
    rate(p.inputPerMTok) &&
    rate(p.outputPerMTok) &&
    optionalRate(p.cacheReadPerMTok) &&
    optionalRate(p.cacheWritePerMTok) &&
    (p.contextWindow === undefined ||
      (typeof p.contextWindow === "number" && Number.isFinite(p.contextWindow) && p.contextWindow > 0))
  );
}
