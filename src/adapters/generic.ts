import type { ParseMeta, ProviderAdapter, TokenUsage, UsageRecord } from "../types.js";
import { count, get, isRecord, makeId, str } from "./util.js";

/**
 * The documented ingest shape — what you post when you control the caller.
 *
 * Unlike the vendor adapters, this one reads a flat, explicit envelope rather
 * than guessing at a provider's response:
 *
 *   { provider, model, durationMs?, requestId?, finishReason?, status?,
 *     errorMessage?,
 *     usage: { inputTokens?, outputTokens?, cachedTokens?,
 *              cacheWriteTokens?, reasoningTokens?, totalTokens? } }
 *
 * `inputTokens` must already exclude `cachedTokens` — same contract as
 * everywhere else. It is last in the registry and matches almost anything, so
 * it acts as the fallback when no vendor adapter claims a payload.
 */
export const genericAdapter: ProviderAdapter = {
  id: "generic",
  displayName: "Generic",

  detect(payload: unknown): boolean {
    if (!isRecord(payload)) {
      return false;
    }
    // Enough to be worth recording: a model, or a usage block in our own shape.
    const usage = get(payload, "usage");
    return (
      typeof payload.model === "string" ||
      (isRecord(usage) && ("inputTokens" in usage || "outputTokens" in usage || "totalTokens" in usage))
    );
  },

  parse(payload: unknown, meta: ParseMeta): UsageRecord {
    const now = (meta.now ?? (() => new Date()))();
    const root = isRecord(payload) ? payload : {};
    const raw = get(root, "usage");
    const u = isRecord(raw) ? raw : undefined;

    const usage: TokenUsage = {
      inputTokens: count(u?.inputTokens),
      outputTokens: count(u?.outputTokens),
      cachedTokens: count(u?.cachedTokens),
      cacheWriteTokens: count(u?.cacheWriteTokens),
      reasoningTokens: count(u?.reasoningTokens),
      totalTokens: count(u?.totalTokens),
    };

    const errorMessage = str(root.errorMessage);
    // An explicit status wins; otherwise an error message implies failure.
    const status = root.status === "error" || (root.status === undefined && errorMessage) ? "error" : "ok";

    return {
      id: makeId(now),
      timestamp: str(root.timestamp) ?? now.toISOString(),
      provider: meta.provider ?? str(root.provider) ?? this.id,
      model: str(root.model) ?? "unknown",
      durationMs: meta.durationMs ?? count(root.durationMs),
      requestId: str(root.requestId),
      finishReason: str(root.finishReason),
      status,
      errorMessage,
      usage,
      source: meta.source,
      usageUnavailable: u === undefined,
    };
  },
};
