import type { UsageRecord } from "./types.js";

/**
 * Presentation helpers, shared by the status bar, the webview and the exports.
 *
 * The single rule: a value the provider never reported renders as the
 * UNAVAILABLE marker, never as "0", "—" next to real zeros, or a blank cell.
 */

export const UNAVAILABLE = "Unavailable";

export function formatTokens(n: number | undefined): string {
  if (n === undefined) {
    return UNAVAILABLE;
  }
  if (n < 1000) {
    return String(n);
  }
  if (n < 1_000_000) {
    // One decimal below 10k (4.2k), none above (42k) — keeps columns narrow.
    return n < 10_000 ? `${(n / 1000).toFixed(1)}k` : `${Math.round(n / 1000)}k`;
  }
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/**
 * USD, with enough precision that a sub-cent request is not displayed as $0.00.
 * Real per-request costs are frequently in the $0.0001 range.
 */
export function formatUsd(usd: number | undefined): string {
  if (usd === undefined) {
    return UNAVAILABLE;
  }
  if (usd === 0) {
    return "$0.00";
  }
  if (usd < 0.01) {
    return `$${usd.toFixed(5)}`;
  }
  if (usd < 1) {
    return `$${usd.toFixed(4)}`;
  }
  return `$${usd.toFixed(2)}`;
}

export function formatDuration(ms: number | undefined): string {
  if (ms === undefined) {
    return UNAVAILABLE;
  }
  if (ms < 1000) {
    return `${Math.round(ms)}ms`;
  }
  if (ms < 60_000) {
    return `${(ms / 1000).toFixed(1)}s`;
  }
  const minutes = Math.floor(ms / 60_000);
  const seconds = Math.round((ms % 60_000) / 1000);
  return `${minutes}m ${seconds}s`;
}

export function formatPercent(used: number, limit: number): string {
  if (limit <= 0) {
    return UNAVAILABLE;
  }
  const pct = (used / limit) * 100;
  return pct < 1 ? `${pct.toFixed(1)}%` : `${Math.round(pct)}%`;
}

/** Status bar text: the shortest thing that is still unambiguous. */
export function statusBarText(record: UsageRecord | undefined): string {
  if (!record) {
    return "$(pulse) AI Tokens";
  }
  const icon = record.status === "error" ? "$(error)" : "$(pulse)";
  const tokens = record.usage.totalTokens ?? record.usage.outputTokens;
  const parts = [tokens === undefined ? UNAVAILABLE : `${formatTokens(tokens)} tok`];
  if (record.cost) {
    parts.push(formatUsd(record.cost.totalUsd));
  }
  return `${icon} ${parts.join(" · ")}`;
}

/** Hover detail for the status bar. Markdown. */
export function statusBarTooltip(record: UsageRecord | undefined): string {
  if (!record) {
    return "No AI requests recorded yet.";
  }

  const lines = [
    `**${record.model}**  \n${record.provider} · ${new Date(record.timestamp).toLocaleTimeString()}`,
    "",
    `Input: ${formatTokens(record.usage.inputTokens)}`,
    `Output: ${formatTokens(record.usage.outputTokens)}`,
  ];

  if (record.usage.cachedTokens !== undefined) {
    lines.push(`Cached: ${formatTokens(record.usage.cachedTokens)}`);
  }
  if (record.usage.reasoningTokens !== undefined) {
    lines.push(`Reasoning: ${formatTokens(record.usage.reasoningTokens)}`);
  }
  lines.push(`Duration: ${formatDuration(record.durationMs)}`);

  if (record.cost) {
    const source = record.cost.pricingSource === "builtin-verified" ? "verified rates" : "your rates";
    lines.push(`Cost: ${formatUsd(record.cost.totalUsd)} (${source})`);
  } else {
    lines.push(`Cost: ${UNAVAILABLE} — no verified pricing for this model`);
  }

  if (record.context) {
    lines.push(
      `Context: ${formatTokens(record.context.used)} / ${formatTokens(record.context.limit)} (${formatPercent(record.context.used, record.context.limit)})`,
    );
  }
  if (record.status === "error" && record.errorMessage) {
    lines.push("", `Error: ${record.errorMessage}`);
  }

  return lines.join("  \n");
}

const CSV_COLUMNS = [
  "timestamp",
  "provider",
  "model",
  "status",
  "durationMs",
  "inputTokens",
  "outputTokens",
  "cachedTokens",
  "cacheWriteTokens",
  "reasoningTokens",
  "totalTokens",
  "costUsd",
  "pricingSource",
  "finishReason",
  // Safe to export: per the UsageRecord contract this never contains prompt or
  // response text. Without it an error row exports with no reason at all.
  "errorMessage",
  "requestId",
  "source",
] as const;

/**
 * CSV export. Unreported values are empty cells, never 0 — a spreadsheet SUM
 * over this column must not count absent data as zero.
 */
export function toCsv(records: readonly UsageRecord[]): string {
  const rows = [CSV_COLUMNS.join(",")];

  for (const r of records) {
    rows.push(
      [
        r.timestamp,
        r.provider,
        r.model,
        r.status,
        r.durationMs,
        r.usage.inputTokens,
        r.usage.outputTokens,
        r.usage.cachedTokens,
        r.usage.cacheWriteTokens,
        r.usage.reasoningTokens,
        r.usage.totalTokens,
        r.cost?.totalUsd,
        r.cost?.pricingSource,
        r.finishReason,
        r.errorMessage,
        r.requestId,
        r.source,
      ]
        .map(csvCell)
        .join(","),
    );
  }

  return rows.join("\n");
}

function csvCell(value: string | number | undefined): string {
  if (value === undefined) {
    return "";
  }
  const text = String(value);
  // Quote when the cell could otherwise break the row, and double inner quotes.
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}
