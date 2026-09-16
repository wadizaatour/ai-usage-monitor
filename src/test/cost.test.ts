import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { computeContextWindow, computeCost } from "../cost.js";
import { lookupPricing, normalizeModelId, parseCustomPricing } from "../pricing.js";

describe("computeCost", () => {
  test("prices input and output at the verified rates", () => {
    // opus-5: $5/MTok in, $25/MTok out.
    const cost = computeCost("claude-opus-5", { inputTokens: 1_000_000, outputTokens: 1_000_000 });
    assert.equal(cost?.inputUsd, 5);
    assert.equal(cost?.outputUsd, 25);
    assert.equal(cost?.totalUsd, 30);
    assert.equal(cost?.pricingSource, "builtin-verified");
  });

  test("bills cache reads and writes separately from full-rate input", () => {
    const cost = computeCost("claude-opus-5", {
      inputTokens: 1_000_000,
      cachedTokens: 1_000_000, // $0.50
      cacheWriteTokens: 1_000_000, // $6.25
    });
    assert.equal(cost?.inputUsd, 5);
    assert.equal(cost?.cachedUsd, 6.75);
  });

  test("uses fable-5-1's published flat cache read rate, not the 0.1x multiplier", () => {
    // The multiplier would give $1.00; the published rate is $0.25.
    const cost = computeCost("claude-fable-5-1", { cachedTokens: 1_000_000 });
    assert.equal(cost?.cachedUsd, 0.25);
  });

  test("returns undefined for a model with no verified pricing", () => {
    assert.equal(computeCost("some-other-model", { inputTokens: 100, outputTokens: 50 }), undefined);
  });

  test("returns undefined rather than a partial total when a billed class is unpriced", () => {
    const custom = { "no-cache-rates": { inputPerMTok: 1, outputPerMTok: 2 } };
    // Input and output alone are priceable.
    assert.ok(computeCost("no-cache-rates", { inputTokens: 100, outputTokens: 50 }, custom));
    // Adding unpriceable cache reads makes the whole total incomplete, and an
    // incomplete total that looks complete is the failure mode we avoid.
    assert.equal(
      computeCost("no-cache-rates", { inputTokens: 100, outputTokens: 50, cachedTokens: 10 }, custom),
      undefined,
    );
  });

  test("returns undefined when nothing was reported", () => {
    assert.equal(computeCost("claude-opus-5", {}), undefined);
  });

  test("distinguishes a reported zero from an absent count", () => {
    const cost = computeCost("claude-opus-5", { inputTokens: 0, outputTokens: 100 });
    assert.equal(cost?.inputUsd, 0);
    assert.ok(cost);
  });

  test("user pricing overrides the built-in table", () => {
    const cost = computeCost(
      "claude-opus-5",
      { inputTokens: 1_000_000 },
      { "claude-opus-5": { inputPerMTok: 1, outputPerMTok: 1 } },
    );
    assert.equal(cost?.inputUsd, 1);
    assert.equal(cost?.pricingSource, "user-configured");
  });

  test("ignores malformed user pricing instead of computing from it", () => {
    const cost = computeCost(
      "claude-opus-5",
      { inputTokens: 1_000_000 },
      { "claude-opus-5": { inputPerMTok: -3, outputPerMTok: 1 } as never },
    );
    // Falls through to the verified table rather than honoring a negative rate.
    assert.equal(cost?.inputUsd, 5);
    assert.equal(cost?.pricingSource, "builtin-verified");
  });
});

describe("normalizeModelId", () => {
  test("strips bedrock prefixes and version tails, flagging the platform", () => {
    assert.deepEqual(normalizeModelId("anthropic.claude-opus-5"), {
      id: "claude-opus-5",
      partnerPlatform: "bedrock",
    });
    assert.deepEqual(normalizeModelId("us.anthropic.claude-opus-5-v1:0"), {
      id: "claude-opus-5",
      partnerPlatform: "bedrock",
    });
  });

  test("strips vertex and dated snapshot suffixes", () => {
    assert.equal(normalizeModelId("claude-opus-4-5@20251101").id, "claude-opus-4-5");
    assert.equal(normalizeModelId("claude-opus-4-5-20251101").id, "claude-opus-4-5");
  });

  test("leaves a plain first-party id alone", () => {
    assert.deepEqual(normalizeModelId("claude-sonnet-5"), { id: "claude-sonnet-5" });
  });
});

describe("lookupPricing", () => {
  test("refuses first-party rates for a partner deployment", () => {
    // Bedrock is billed separately, so first-party rates would be wrong.
    assert.equal(lookupPricing("anthropic.claude-opus-5"), undefined);
  });

  test("lets a user price a partner deployment by its exact id", () => {
    const found = lookupPricing("anthropic.claude-opus-5", {
      "anthropic.claude-opus-5": { inputPerMTok: 6, outputPerMTok: 30 },
    });
    assert.equal(found?.pricing.inputPerMTok, 6);
    assert.equal(found?.source, "user-configured");
  });
});

describe("parseCustomPricing", () => {
  test("translates the documented settings keys into rates", () => {
    // The shape a user writes after reading the settings description must be
    // the shape that actually prices their requests.
    const parsed = parseCustomPricing({
      "my-model": { input: 3, output: 15, cachedInput: 0.3, contextWindow: 200_000 },
    });
    assert.deepEqual(parsed["my-model"], {
      inputPerMTok: 3,
      outputPerMTok: 15,
      cacheReadPerMTok: 0.3,
      cacheWritePerMTok: undefined,
      contextWindow: 200_000,
    });

    const cost = computeCost("my-model", { inputTokens: 1_000_000 }, parsed);
    assert.equal(cost?.inputUsd, 3);
    assert.equal(cost?.pricingSource, "user-configured");
  });

  test("drops malformed entries and reports them, keeping valid siblings", () => {
    const invalid: string[] = [];
    const parsed = parseCustomPricing(
      {
        good: { input: 1, output: 2 },
        missingOutput: { input: 1 },
        negative: { input: -1, output: 2 },
        notAnObject: "3",
      },
      (model) => invalid.push(model),
    );
    assert.deepEqual(Object.keys(parsed), ["good"]);
    assert.deepEqual(invalid.sort(), ["missingOutput", "negative", "notAnObject"]);
  });

  test("tolerates a non-object setting value", () => {
    assert.deepEqual(parseCustomPricing(undefined), {});
    assert.deepEqual(parseCustomPricing([1, 2]), {});
  });
});

describe("computeContextWindow", () => {
  test("counts cached input as occupying the window", () => {
    const ctx = computeContextWindow("claude-haiku-4-5", {
      inputTokens: 1000,
      cachedTokens: 4000,
      outputTokens: 500,
    });
    assert.deepEqual(ctx, { used: 5500, limit: 200_000 });
  });

  test("excludes cache writes, which are the same tokens counted twice", () => {
    const ctx = computeContextWindow("claude-haiku-4-5", {
      inputTokens: 1000,
      cacheWriteTokens: 9999,
    });
    assert.equal(ctx?.used, 1000);
  });

  test("returns undefined rather than guessing an unknown window", () => {
    assert.equal(computeContextWindow("mystery-model", { inputTokens: 10 }), undefined);
  });
});
