import type { UsageRecord } from "./types.js";

/**
 * In-memory ring of recent requests, newest first, with derived totals.
 *
 * The store is deliberately free of vscode imports so it can be unit-tested;
 * persistence is the extension's job, which hands in a snapshot at activation
 * and listens for changes.
 */

export interface UsageTotals {
  requests: number;
  errors: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
  /** Summed cost of the records that had one. */
  costUsd: number;
  /**
   * Records with no verified cost. When non-zero the UI must qualify the total
   * as a floor ("$1.23 over 40 of 52 requests") rather than presenting it as
   * the complete spend.
   */
  recordsWithoutCost: number;
}

export type StoreListener = (records: readonly UsageRecord[]) => void;

export class UsageStore {
  private records: UsageRecord[] = [];
  private readonly listeners = new Set<StoreListener>();
  private readonly requestIds = new Set<string>();
  private maxEntries: number;

  constructor(maxEntries: number, initial: readonly UsageRecord[] = []) {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    this.records = [...initial].slice(0, this.maxEntries);
    // Seed from persisted history so a reload does not re-add what a source
    // re-reads from disk on the next startup.
    for (const record of this.records) {
      if (record.requestId !== undefined) {
        this.requestIds.add(record.requestId);
      }
    }
  }

  /**
   * Add a record, ignoring one already held.
   *
   * Identity is the provider's own request id. Discovered sources re-read
   * transcripts whenever detection restarts — a settings change, a window
   * reload — and a resumed session replays earlier turns, so the same request
   * legitimately arrives more than once. Deduping here rather than in each
   * source means every path gets it, and duplicated spend never inflates a
   * total the user is reading as their bill.
   *
   * Records with no request id are always added: absent ids are not evidence
   * of sameness, and dropping them would silently lose real requests.
   */
  add(record: UsageRecord): void {
    if (record.requestId !== undefined && this.requestIds.has(record.requestId)) {
      return;
    }
    if (record.requestId !== undefined) {
      this.requestIds.add(record.requestId);
    }

    this.records.unshift(record);
    if (this.records.length > this.maxEntries) {
      for (const dropped of this.records.splice(this.maxEntries)) {
        // Forget ids that aged out, so the set tracks the ring rather than
        // growing without bound across a long-running window.
        if (dropped.requestId !== undefined) {
          this.requestIds.delete(dropped.requestId);
        }
      }
    }
    this.emit();
  }

  all(): readonly UsageRecord[] {
    return this.records;
  }

  latest(): UsageRecord | undefined {
    return this.records[0];
  }

  clear(): void {
    this.records = [];
    this.requestIds.clear();
    this.emit();
  }

  /** Trim to a new cap when the setting changes. */
  setMaxEntries(maxEntries: number): void {
    this.maxEntries = Math.max(1, Math.floor(maxEntries));
    if (this.records.length > this.maxEntries) {
      for (const dropped of this.records.splice(this.maxEntries)) {
        if (dropped.requestId !== undefined) {
          this.requestIds.delete(dropped.requestId);
        }
      }
      this.emit();
    }
  }

  onDidChange(listener: StoreListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) {
      listener(this.records);
    }
  }
}

/**
 * Totals over a set of records.
 *
 * Absent token counts contribute nothing rather than zero, and records without
 * verified cost are counted separately instead of being treated as free — a
 * sum that silently skips unpriced requests reads as complete when it is not.
 */
export function totals(records: readonly UsageRecord[]): UsageTotals {
  const result: UsageTotals = {
    requests: records.length,
    errors: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
    costUsd: 0,
    recordsWithoutCost: 0,
  };

  for (const record of records) {
    if (record.status === "error") {
      result.errors += 1;
    }
    result.inputTokens += record.usage.inputTokens ?? 0;
    result.outputTokens += record.usage.outputTokens ?? 0;
    result.cachedTokens += record.usage.cachedTokens ?? 0;
    if (record.cost) {
      result.costUsd += record.cost.totalUsd;
    } else {
      result.recordsWithoutCost += 1;
    }
  }

  return result;
}

/** Per-model rollup, most expensive first, for the summary table. */
export function byModel(records: readonly UsageRecord[]): Array<UsageTotals & { model: string }> {
  const groups = new Map<string, UsageRecord[]>();
  for (const record of records) {
    const existing = groups.get(record.model);
    if (existing) {
      existing.push(record);
    } else {
      groups.set(record.model, [record]);
    }
  }

  return [...groups.entries()]
    .map(([model, group]) => ({ model, ...totals(group) }))
    .sort((a, b) => b.costUsd - a.costUsd || b.requests - a.requests);
}
