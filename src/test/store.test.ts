import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { UsageStore, byModel, totals } from "../store.js";
import { formatTokens, formatUsd, toCsv, UNAVAILABLE } from "../format.js";
import type { UsageRecord } from "../types.js";

function record(over: Partial<UsageRecord> = {}): UsageRecord {
  return {
    id: Math.random().toString(36).slice(2),
    timestamp: "2026-09-16T12:00:00.000Z",
    provider: "anthropic",
    model: "claude-opus-5",
    status: "ok",
    usage: { inputTokens: 100, outputTokens: 50 },
    source: "test",
    usageUnavailable: false,
    ...over,
  };
}

describe("UsageStore", () => {
  test("keeps newest first and enforces the cap", () => {
    const store = new UsageStore(2);
    store.add(record({ model: "a" }));
    store.add(record({ model: "b" }));
    store.add(record({ model: "c" }));
    assert.deepEqual(
      store.all().map((r) => r.model),
      ["c", "b"],
    );
    assert.equal(store.latest()?.model, "c");
  });

  test("trims when the cap is lowered", () => {
    const store = new UsageStore(5);
    for (let i = 0; i < 5; i++) {
      store.add(record());
    }
    store.setMaxEntries(2);
    assert.equal(store.all().length, 2);
  });

  test("ignores a repeated request id", () => {
    // Sources re-read transcripts on every restart; duplicated spend must not
    // inflate a total the user reads as their bill.
    const store = new UsageStore(10);
    store.add(record({ requestId: "msg_1" }));
    store.add(record({ requestId: "msg_1" }));
    store.add(record({ requestId: "msg_2" }));
    assert.equal(store.all().length, 2);
  });

  test("always adds records with no request id", () => {
    // Absent ids are not evidence of sameness.
    const store = new UsageStore(10);
    store.add(record());
    store.add(record());
    assert.equal(store.all().length, 2);
  });

  test("seeds dedupe from persisted history so a reload does not re-add", () => {
    const store = new UsageStore(10, [record({ requestId: "msg_1" })]);
    store.add(record({ requestId: "msg_1" }));
    assert.equal(store.all().length, 1);
  });

  test("forgets ids that age out of the ring", () => {
    // Otherwise the id set grows without bound in a long-running window.
    const store = new UsageStore(1);
    store.add(record({ requestId: "msg_1" }));
    store.add(record({ requestId: "msg_2" }));
    // msg_1 has been evicted, so it is no longer a duplicate.
    store.add(record({ requestId: "msg_1" }));
    assert.equal(store.latest()?.requestId, "msg_1");
  });

  test("notifies listeners and stops after unsubscribe", () => {
    const store = new UsageStore(10);
    let calls = 0;
    const off = store.onDidChange(() => {
      calls += 1;
    });
    store.add(record());
    assert.equal(calls, 1);
    off();
    store.add(record());
    assert.equal(calls, 1);
  });
});

describe("totals", () => {
  test("counts unpriced records separately rather than as free", () => {
    const priced = {
      inputUsd: 1,
      outputUsd: 1,
      cachedUsd: 0,
      totalUsd: 2,
      pricingSource: "builtin-verified" as const,
    };
    const t = totals([record({ cost: priced }), record(), record({ status: "error" })]);
    assert.equal(t.requests, 3);
    assert.equal(t.errors, 1);
    assert.equal(t.costUsd, 2);
    // Two records had no verified price, so the $2 is a floor, not the total.
    assert.equal(t.recordsWithoutCost, 2);
  });

  test("treats absent counts as absent, not zero", () => {
    const t = totals([record({ usage: {} })]);
    assert.equal(t.inputTokens, 0);
    assert.equal(t.requests, 1);
  });
});

describe("byModel", () => {
  test("groups and sorts by cost", () => {
    const cheap = { inputUsd: 0, outputUsd: 1, cachedUsd: 0, totalUsd: 1, pricingSource: "builtin-verified" as const };
    const dear = { ...cheap, totalUsd: 9 };
    const rows = byModel([
      record({ model: "cheap", cost: cheap }),
      record({ model: "dear", cost: dear }),
      record({ model: "cheap", cost: cheap }),
    ]);
    assert.deepEqual(
      rows.map((r) => r.model),
      ["dear", "cheap"],
    );
    assert.equal(rows[1].requests, 2);
  });
});

describe("formatting", () => {
  test("renders absent values as Unavailable, never as zero", () => {
    assert.equal(formatTokens(undefined), UNAVAILABLE);
    assert.equal(formatUsd(undefined), UNAVAILABLE);
    assert.equal(formatTokens(0), "0");
    assert.equal(formatUsd(0), "$0.00");
  });

  test("keeps sub-cent costs visible instead of rounding to $0.00", () => {
    assert.equal(formatUsd(0.000_123), "$0.00012");
    assert.notEqual(formatUsd(0.0004), "$0.00");
  });

  test("abbreviates token counts", () => {
    assert.equal(formatTokens(999), "999");
    assert.equal(formatTokens(4200), "4.2k");
    assert.equal(formatTokens(42_000), "42k");
    assert.equal(formatTokens(1_500_000), "1.50M");
  });
});

describe("toCsv", () => {
  test("leaves unreported values as empty cells, not zeros", () => {
    const csv = toCsv([record({ usage: { inputTokens: 100 } })]);
    const [header, row] = csv.split("\n");
    const cells = row.split(",");
    const outputIndex = header.split(",").indexOf("outputTokens");
    assert.equal(cells[outputIndex], "");
  });

  test("quotes cells that would otherwise break the row", () => {
    const csv = toCsv([record({ status: "error", errorMessage: 'bad, "quoted"' })]);
    assert.ok(csv.includes('"bad, ""quoted"""'));
  });
});
