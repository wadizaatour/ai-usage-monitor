import type { ParseMeta, ProviderAdapter, UsageRecord } from "../types.js";
import { anthropicAdapter } from "./anthropic.js";
import { openaiAdapter } from "./openai.js";
import { genericAdapter } from "./generic.js";

/**
 * Adapters in priority order. Vendor adapters first, each with a narrow
 * `detect`; the generic envelope last as the catch-all.
 */
export const ADAPTERS: readonly ProviderAdapter[] = [
  anthropicAdapter,
  openaiAdapter,
  genericAdapter,
];

/**
 * Parse a payload with the first adapter that recognizes it.
 *
 * Returns undefined when nothing matches, so the caller can log the payload as
 * unrecognized rather than storing an empty record that looks like a real
 * request with no usage.
 */
export function parseUsage(
  payload: unknown,
  meta: ParseMeta,
  adapters: readonly ProviderAdapter[] = ADAPTERS,
): UsageRecord | undefined {
  for (const adapter of adapters) {
    if (adapter.detect(payload)) {
      return adapter.parse(payload, meta);
    }
  }
  return undefined;
}

export { anthropicAdapter, openaiAdapter, genericAdapter };
