import type { ParseMeta, ProviderAdapter, TokenUsage, UsageRecord } from "../types.js";
import { count, difference, get, isRecord, makeId, str } from "./util.js";

/**
 * OpenAI Chat Completions and Responses API.
 *
 * Two shapes, one adapter, because the token semantics are identical and only
 * the field names differ:
 *   chat:      { prompt_tokens, completion_tokens, total_tokens }
 *   responses: { input_tokens,  output_tokens,     total_tokens }
 *
 * The important difference from Anthropic: `prompt_tokens`/`input_tokens` are
 * *inclusive* of cached tokens. Our contract says `inputTokens` is the portion
 * billed at full rate, so the cached count is subtracted here. Without that
 * subtraction every cached request would be billed twice for the same tokens.
 */
export const openaiAdapter: ProviderAdapter = {
  id: "openai",
  displayName: "OpenAI",

  detect(payload: unknown): boolean {
    if (!isRecord(payload)) {
      return false;
    }
    const usage = get(payload, "usage");
    if (isRecord(usage) && ("prompt_tokens" in usage || "completion_tokens" in usage)) {
      return true;
    }
    return payload.object === "chat.completion" || payload.object === "response";
  },

  parse(payload: unknown, meta: ParseMeta): UsageRecord {
    const now = (meta.now ?? (() => new Date()))();
    const root = isRecord(payload) ? payload : {};
    const raw = get(root, "usage");
    const u = isRecord(raw) ? raw : undefined;

    const cachedTokens =
      count(get(u, "prompt_tokens_details", "cached_tokens")) ??
      count(get(u, "input_tokens_details", "cached_tokens"));

    const reportedInput = count(u?.prompt_tokens) ?? count(u?.input_tokens);
    const outputTokens = count(u?.completion_tokens) ?? count(u?.output_tokens);

    const usage: TokenUsage = {
      // Subtract the cached portion so the two classes bill separately.
      inputTokens: difference(reportedInput, cachedTokens),
      outputTokens,
      cachedTokens,
      // Reasoning tokens are a subset of output, not an addition to it.
      reasoningTokens:
        count(get(u, "completion_tokens_details", "reasoning_tokens")) ??
        count(get(u, "output_tokens_details", "reasoning_tokens")),
      // Trust the provider's own total; it is inclusive of everything.
      totalTokens: count(u?.total_tokens),
    };

    // Chat puts the reason on the first choice; Responses uses incomplete_details.
    const choice = Array.isArray(root.choices) ? root.choices[0] : undefined;
    const finishReason =
      str(get(choice, "finish_reason")) ?? str(get(root, "incomplete_details", "reason"));

    const errorMessage = str(get(root, "error", "message"));

    return {
      id: makeId(now),
      timestamp: now.toISOString(),
      provider: meta.provider ?? this.id,
      model: str(root.model) ?? "unknown",
      durationMs: meta.durationMs,
      requestId: str(root.id),
      finishReason,
      status: errorMessage ? "error" : "ok",
      errorMessage,
      usage,
      source: meta.source,
      usageUnavailable: u === undefined,
    };
  },
};
