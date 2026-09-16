/**
 * The shape every adapter produces and every view consumes.
 *
 * Design rule that runs through this whole file: a field is `undefined` when the
 * provider did not tell us, and the UI renders "Unavailable" for it. Nothing here is
 * ever estimated, defaulted to zero, or back-filled from a tokenizer. A zero means
 * the provider reported zero.
 */

/**
 * Token counts exactly as reported. Any field may be absent.
 *
 * One normalization the adapters must perform, because providers disagree and
 * getting it wrong double-counts the bill: `inputTokens` is always the input
 * billed at the *full* rate, exclusive of `cachedTokens`. Anthropic already
 * reports it that way; OpenAI's `prompt_tokens` is inclusive of
 * `cached_tokens`, so its adapter subtracts. Likewise `outputTokens` is
 * inclusive of `reasoningTokens`, which OpenAI bills as output.
 */
export interface TokenUsage {
  /** Input billed at the full rate. Excludes `cachedTokens`. */
  inputTokens?: number;
  /** Output tokens. Includes `reasoningTokens` when present. */
  outputTokens?: number;
  /** Reported total. Derived from input+output only when both are present. */
  totalTokens?: number;
  /** Tokens served from a prompt cache (Anthropic cache_read, OpenAI cached_tokens). */
  cachedTokens?: number;
  /** Tokens written into a prompt cache this request (Anthropic only). */
  cacheWriteTokens?: number;
  /** Reasoning tokens billed as output (OpenAI o-series / reasoning models). */
  reasoningTokens?: number;
}

/** Context-window occupancy, only when the window size is known for the model. */
export interface ContextWindow {
  /** Tokens occupying the window (input + output for the turn). */
  used: number;
  /** The model's maximum context, from a verified table or reported by the provider. */
  limit: number;
}

/** Cost is only ever populated from verified pricing. */
export interface CostBreakdown {
  inputUsd: number;
  outputUsd: number;
  cachedUsd: number;
  totalUsd: number;
  /** Where the rates came from, shown in the UI so the number is auditable. */
  pricingSource: "builtin-verified" | "user-configured";
}

export type RequestStatus = "ok" | "error";

/** One AI request, as recorded. */
export interface UsageRecord {
  /** Local record id. Not the provider's. */
  id: string;
  /** ISO-8601, when the request completed. */
  timestamp: string;
  provider: string;
  model: string;
  /** Wall-clock duration in ms, when the source measured it. */
  durationMs?: number;
  /** The provider's own request id, when it returns one. */
  requestId?: string;
  /** stop | length | tool_calls | content_filter | … exactly as reported. */
  finishReason?: string;
  status: RequestStatus;
  /** Provider error message. Never contains prompt or response text. */
  errorMessage?: string;
  usage: TokenUsage;
  context?: ContextWindow;
  cost?: CostBreakdown;
  /** Which integration recorded this: adapter name, ingest, or the public API. */
  source: string;
  /** True when the provider returned no usage block at all. */
  usageUnavailable: boolean;
}

/**
 * A provider adapter: the single place where one vendor's response shape is
 * understood. Adding a provider means adding one of these and nothing else.
 */
export interface ProviderAdapter {
  /** Stable id, also used as the `provider` on records when none is supplied. */
  readonly id: string;
  readonly displayName: string;
  /** Cheap structural check: can this adapter read that payload? */
  detect(payload: unknown): boolean;
  /** Pull out whatever the payload actually contains. Never invent values. */
  parse(payload: unknown, meta: ParseMeta): UsageRecord;
}

/** Everything the caller knows that the payload itself does not carry. */
export interface ParseMeta {
  durationMs?: number;
  /** Overrides the adapter's own id, e.g. "anthropic" behind a LiteLLM proxy. */
  provider?: string;
  source: string;
  /** Injected so tests are deterministic. */
  now?: () => Date;
}
