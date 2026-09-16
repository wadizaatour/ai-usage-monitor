import type { ParseMeta, ProviderAdapter, TokenUsage, UsageRecord } from "../types.js";
import { count, get, isRecord, makeId, str, sum } from "./util.js";

/**
 * Anthropic Messages API responses.
 *
 * Usage shape:
 *   { input_tokens, output_tokens,
 *     cache_read_input_tokens, cache_creation_input_tokens }
 *
 * `input_tokens` already excludes both cache fields, which matches our contract
 * directly — no subtraction, unlike the OpenAI adapter.
 */
export const anthropicAdapter: ProviderAdapter = {
  id: "anthropic",
  displayName: "Anthropic",

  detect(payload: unknown): boolean {
    if (!isRecord(payload)) {
      return false;
    }
    // A Messages response is type "message"; that alone is a solid signal.
    if (payload.type === "message" && payload.role === "assistant") {
      return true;
    }
    // Otherwise require the Anthropic-specific usage field names, so we don't
    // claim an OpenAI payload that happens to carry a `model`.
    const usage = get(payload, "usage");
    return (
      isRecord(usage) &&
      ("input_tokens" in usage || "cache_read_input_tokens" in usage || "cache_creation_input_tokens" in usage)
    );
  },

  parse(payload: unknown, meta: ParseMeta): UsageRecord {
    const now = (meta.now ?? (() => new Date()))();
    const root = isRecord(payload) ? payload : {};
    const raw = get(root, "usage");
    const u = isRecord(raw) ? raw : undefined;

    const inputTokens = count(u?.input_tokens);
    const outputTokens = count(u?.output_tokens);
    const cachedTokens = count(u?.cache_read_input_tokens);

    // Cache writes are reported either as a flat count or, when multiple TTLs
    // are in play, broken out per TTL. Sum the breakdown when present.
    const cacheWriteTokens =
      count(u?.cache_creation_input_tokens) ??
      sum(
        count(get(u, "cache_creation", "ephemeral_5m_input_tokens")),
        count(get(u, "cache_creation", "ephemeral_1h_input_tokens")),
      );

    const usage: TokenUsage = {
      inputTokens,
      outputTokens,
      cachedTokens,
      cacheWriteTokens,
      // Anthropic reports no total; derive only when both halves are known.
      totalTokens:
        inputTokens !== undefined && outputTokens !== undefined
          ? inputTokens + outputTokens + (cachedTokens ?? 0)
          : undefined,
    };

    // `stop_reason: "refusal"` is a completed request, not a transport error:
    // it is recorded as ok with the finish reason preserved, and the category
    // from stop_details explains it. stop_details is null for every other
    // stop_reason, so it is read only in that branch.
    const stopReason = str(root.stop_reason);
    const refusalCategory =
      stopReason === "refusal" ? str(get(root, "stop_details", "category")) : undefined;

    const errorMessage = str(get(root, "error", "message"));

    return {
      id: makeId(now),
      timestamp: now.toISOString(),
      provider: meta.provider ?? this.id,
      model: str(root.model) ?? "unknown",
      durationMs: meta.durationMs,
      requestId: str(root.id),
      finishReason: refusalCategory ? `refusal:${refusalCategory}` : stopReason,
      status: errorMessage ? "error" : "ok",
      errorMessage,
      usage,
      source: meta.source,
      usageUnavailable: u === undefined,
    };
  },
};
