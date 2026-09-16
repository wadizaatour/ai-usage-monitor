import type { UsageRecord } from "../types.js";

/**
 * A usage *source*: a locally-installed AI tool this extension can read usage
 * from without the tool cooperating.
 *
 * This is the counterpart to ProviderAdapter. An adapter understands a
 * response *shape*; a source knows where a particular tool leaves its records
 * on disk and how to follow them as they are written. Adding support for a new
 * tool means adding one of these and registering it — the store, pricing, and
 * views are untouched.
 *
 * Every source is read-only. Nothing here writes to, configures, or otherwise
 * disturbs the tool being monitored: a monitor that can break the thing it
 * watches is worse than no monitor.
 */
export interface UsageSource {
  /** Stable id, also used as the `source` on records it produces. */
  readonly id: string;
  readonly displayName: string;

  /**
   * Is this tool installed and has it actually produced data?
   *
   * Returns the paths that will be watched, or undefined when the tool is not
   * present. "Installed but idle" is a real state and must resolve to a path
   * list, not undefined — otherwise a freshly-installed tool looks absent
   * until its first request, which reads as the extension being broken.
   */
  detect(): Promise<DetectedSource | undefined>;

  /**
   * Begin watching. Calls `onRecord` for each usage record found, including
   * pre-existing history on the first pass when `backfill` is set.
   */
  watch(options: WatchOptions): Promise<SourceWatcher>;
}

export interface DetectedSource {
  /** Directories or files that will be watched, for the diagnostics log. */
  readonly paths: readonly string[];
  /** Human-readable version, when the tool exposes one cheaply. */
  readonly version?: string;
}

export interface WatchOptions {
  /** Emit records already on disk before watching for new ones. */
  backfill: boolean;
  /**
   * Ignore historical records older than this. Prevents a first run from
   * flooding the view with months of old sessions.
   */
  backfillSince?: Date;
  onRecord: (record: UsageRecord) => void;
  log: (message: string) => void;
}

export interface SourceWatcher {
  readonly id: string;
  dispose(): void;
}
