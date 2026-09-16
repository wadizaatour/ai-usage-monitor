import type { UsageRecord } from "./types.js";
import { byModel, totals } from "./store.js";
import { formatDuration, formatPercent, formatTokens, formatUsd, UNAVAILABLE } from "./format.js";

/**
 * Turns records into the fully-formatted state the webview renders.
 *
 * Kept separate from webview.ts, which imports `vscode`, so these presentation
 * rules can be tested under plain `node --test`. The webview script does no
 * arithmetic and no formatting of its own — every string it displays is decided
 * here, which is what keeps "Unavailable" a single rule rather than a
 * convention each renderer has to remember.
 */

/** One labelled value in an expanded request's detail grid. */
export interface DetailField {
  label: string;
  value: string;
  /** Renders muted and italic — an absent value, not a real one. */
  absent: boolean;
}

export interface ViewRow {
  id: string;
  time: string;
  provider: string;
  model: string;
  status: "ok" | "error";
  /** Collapsed-row summary: the number most worth scanning. */
  headline: string;
  cost: string;
  costAbsent: boolean;
  costTitle: string;
  /** Shown only when the row is expanded. */
  fields: DetailField[];
  note: string | undefined;
  contextPct: number | undefined;
}

export interface ViewState {
  summary: {
    requests: string;
    errors: string;
    tokens: string;
    cost: string;
    costAbsent: boolean;
    /** Set when some requests had no verified price, so cost is a floor. */
    costCaveat: string | undefined;
  };
  /** The most recent request, surfaced above the collapsed history. */
  latest: ViewRow | undefined;
  /** Everything except `latest`. */
  history: ViewRow[];
  models: Array<{ model: string; requests: string; tokens: string; cost: string }>;
}

export function buildState(records: readonly UsageRecord[]): ViewState {
  const t = totals(records);
  const rows = records.map(toRow);

  return {
    summary: {
      requests: String(t.requests),
      errors: String(t.errors),
      tokens: formatTokens(t.inputTokens + t.outputTokens + t.cachedTokens),
      cost: t.requests === 0 ? UNAVAILABLE : formatUsd(t.costUsd),
      costAbsent: t.requests === 0,
      // When any request lacks verified pricing the sum is a floor, not a
      // total, and the UI has to say which — otherwise it reads as complete.
      costCaveat:
        t.recordsWithoutCost > 0
          ? `Cost covers ${t.requests - t.recordsWithoutCost} of ${t.requests} requests; ${t.recordsWithoutCost} had no verified pricing.`
          : undefined,
    },
    // Records are newest-first, so the head is the latest request. Splitting it
    // out is what lets the history stay collapsed without hiding the one thing
    // you are usually waiting to see.
    latest: rows[0],
    history: rows.slice(1),
    models: byModel(records).map((m) => ({
      model: m.model,
      requests: String(m.requests),
      tokens: formatTokens(m.inputTokens + m.outputTokens + m.cachedTokens),
      cost: m.recordsWithoutCost === m.requests ? UNAVAILABLE : formatUsd(m.costUsd),
    })),
  };
}

function toRow(record: UsageRecord): ViewRow {
  const note =
    record.status === "error"
      ? (record.errorMessage ?? "Request failed")
      : record.usageUnavailable
        ? "Provider reported no usage for this request"
        : undefined;

  const tokens = (label: string, value: number | undefined): DetailField =>
    value === undefined
      ? { label, value: UNAVAILABLE, absent: true }
      : { label, value: formatTokens(value), absent: false };

  const text = (label: string, value: string): DetailField => ({ label, value, absent: false });

  const fields: DetailField[] = [
    tokens("Input", record.usage.inputTokens),
    tokens("Output", record.usage.outputTokens),
  ];

  // Optional classes appear only when the provider reported them, so the grid
  // stays short for the common case instead of a wall of "Unavailable".
  if (record.usage.cachedTokens !== undefined) {
    fields.push(tokens("Cached", record.usage.cachedTokens));
  }
  if (record.usage.cacheWriteTokens !== undefined) {
    fields.push(tokens("Cache write", record.usage.cacheWriteTokens));
  }
  if (record.usage.reasoningTokens !== undefined) {
    fields.push(tokens("Reasoning", record.usage.reasoningTokens));
  }

  fields.push(
    {
      label: "Duration",
      value: formatDuration(record.durationMs),
      absent: record.durationMs === undefined,
    },
    text("Provider", record.provider),
    text("Source", record.source),
  );

  if (record.finishReason !== undefined) {
    fields.push(text("Finish", record.finishReason));
  }
  if (record.context) {
    fields.push(
      text(
        "Context",
        `${formatTokens(record.context.used)} / ${formatTokens(record.context.limit)} (${formatPercent(record.context.used, record.context.limit)})`,
      ),
    );
  }

  // Total tokens, falling back to output when the provider reported no total.
  const headlineTokens = record.usage.totalTokens ?? record.usage.outputTokens;

  return {
    id: record.id,
    time: new Date(record.timestamp).toLocaleTimeString(),
    provider: record.provider,
    model: record.model,
    status: record.status,
    headline: headlineTokens === undefined ? UNAVAILABLE : `${formatTokens(headlineTokens)} tok`,
    cost: record.cost ? formatUsd(record.cost.totalUsd) : UNAVAILABLE,
    costAbsent: !record.cost,
    costTitle: record.cost
      ? record.cost.pricingSource === "builtin-verified"
        ? "Computed from built-in verified pricing"
        : "Computed from your configured pricing"
      : `No verified pricing for ${record.model}. Add it under aiUsageMonitor.pricing.custom.`,
    fields,
    note,
    contextPct: record.context ? (record.context.used / record.context.limit) * 100 : undefined,
  };
}
