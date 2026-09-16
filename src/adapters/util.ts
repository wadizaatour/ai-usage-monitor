/** Shared, deliberately strict payload readers used by every adapter. */

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read a non-negative integer token count.
 *
 * Strict on purpose: a string "1234", a float, a negative, or a null all return
 * undefined rather than being coerced. An adapter that coerces turns a provider
 * shape change into a plausible wrong number instead of a visible "Unavailable".
 */
export function count(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 ? value : undefined;
}

export function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

export function get(source: unknown, ...path: string[]): unknown {
  let cursor: unknown = source;
  for (const key of path) {
    if (!isRecord(cursor)) {
      return undefined;
    }
    cursor = cursor[key];
  }
  return cursor;
}

/** Sum, but undefined when every part is undefined — so 0 always means zero. */
export function sum(...parts: Array<number | undefined>): number | undefined {
  const known = parts.filter((n): n is number => n !== undefined);
  return known.length > 0 ? known.reduce((a, b) => a + b, 0) : undefined;
}

/** Non-negative difference, undefined if either side is unknown. */
export function difference(total: number | undefined, part: number | undefined): number | undefined {
  if (total === undefined) {
    return undefined;
  }
  if (part === undefined) {
    return total;
  }
  return Math.max(0, total - part);
}

let counter = 0;

/** Record id. Monotonic suffix keeps ids unique within a millisecond. */
export function makeId(now: Date): string {
  counter = (counter + 1) % 1_000_000;
  return `${now.getTime().toString(36)}-${counter.toString(36)}`;
}
