import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { buildState } from "../view-state.js";
import { UNAVAILABLE } from "../format.js";
import type { UsageRecord } from "../types.js";

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: "2026-09-16T12:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    status: "ok",
    usage: { inputTokens: 100, outputTokens: 50, totalTokens: 150 },
    source: "claude-code",
    usageUnavailable: false,
    ...over,
  };
}

const priced = {
  inputUsd: 1,
  outputUsd: 1,
  cachedUsd: 0,
  totalUsd: 2,
  pricingSource: "builtin-verified" as const,
};

describe("buildState", () => {
  test("splits the newest request out of the collapsed history", () => {
    // The latest request is what you are usually waiting on, so it stays
    // visible while everything else collapses behind a disclosure.
    const state = buildState([
      record({ model: "newest" }),
      record({ model: "older" }),
      record({ model: "oldest" }),
    ]);

    assert.equal(state.latest?.model, "newest");
    assert.deepEqual(
      state.history.map((r) => r.model),
      ["older", "oldest"],
    );
  });

  test("a single request leaves the history empty", () => {
    const state = buildState([record()]);
    assert.ok(state.latest);
    assert.equal(state.history.length, 0);
  });

  test("an empty store has no latest and no history", () => {
    const state = buildState([]);
    assert.equal(state.latest, undefined);
    assert.deepEqual(state.history, []);
    assert.equal(state.summary.cost, UNAVAILABLE);
    assert.equal(state.summary.costAbsent, true);
  });

  test("the collapsed line carries total tokens and cost", () => {
    const state = buildState([record({ cost: priced })]);
    assert.equal(state.latest?.headline, "150 tok");
    assert.equal(state.latest?.cost, "$2.00");
    assert.equal(state.latest?.costAbsent, false);
  });

  test("falls back to output tokens when no total was reported", () => {
    const state = buildState([record({ usage: { outputTokens: 42 } })]);
    assert.equal(state.latest?.headline, "42 tok");
  });

  test("marks an unpriced request rather than showing a zero cost", () => {
    const state = buildState([record()]);
    assert.equal(state.latest?.cost, UNAVAILABLE);
    assert.equal(state.latest?.costAbsent, true);
    assert.match(state.latest?.costTitle ?? "", /No verified pricing/);
  });

  test("lists optional token classes only when the provider reported them", () => {
    const plain = buildState([record()]).latest;
    assert.equal(labels(plain).includes("Cached"), false);

    const cached = buildState([
      record({ usage: { inputTokens: 1, outputTokens: 1, cachedTokens: 900, reasoningTokens: 10 } }),
    ]).latest;
    assert.ok(labels(cached).includes("Cached"));
    assert.ok(labels(cached).includes("Reasoning"));
  });

  test("always includes the core fields, marking absent ones", () => {
    const row = buildState([record({ durationMs: undefined })]).latest;
    const duration = row?.fields.find((f) => f.label === "Duration");
    assert.equal(duration?.value, UNAVAILABLE);
    assert.equal(duration?.absent, true);

    const source = row?.fields.find((f) => f.label === "Source");
    assert.equal(source?.value, "claude-code");
    assert.equal(source?.absent, false);
  });

  test("surfaces an error message as the row note", () => {
    const state = buildState([record({ status: "error", errorMessage: "rate limited" })]);
    assert.equal(state.latest?.note, "rate limited");
    assert.equal(state.latest?.status, "error");
  });

  test("notes when the provider reported no usage at all", () => {
    const state = buildState([record({ usageUnavailable: true, usage: {} })]);
    assert.match(state.latest?.note ?? "", /no usage/i);
  });

  test("qualifies the summary cost when some requests were unpriced", () => {
    const state = buildState([record({ cost: priced }), record()]);
    assert.match(state.summary.costCaveat ?? "", /covers 1 of 2/);
  });

  test("omits the caveat when every request is priced", () => {
    const state = buildState([record({ cost: priced })]);
    assert.equal(state.summary.costCaveat, undefined);
  });

  test("reports context as a percentage for the gauge", () => {
    const state = buildState([record({ context: { used: 50_000, limit: 200_000 } })]);
    assert.equal(state.latest?.contextPct, 25);
    assert.ok(labels(state.latest).includes("Context"));
  });

  test("leaves contextPct unset when the window is unknown", () => {
    const state = buildState([record()]);
    assert.equal(state.latest?.contextPct, undefined);
  });
});

function labels(row: { fields: Array<{ label: string }> } | undefined): string[] {
  return (row?.fields ?? []).map((f) => f.label);
}
