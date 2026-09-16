import type { UsageRecord } from "../types.js";
import type { SourceWatcher, UsageSource } from "./types.js";
import { claudeCodeSource } from "./claude-code.js";

export type { UsageSource, SourceWatcher, DetectedSource, WatchOptions } from "./types.js";
export { claudeCodeSource };

/** Every tool this extension can read usage from. */
export const SOURCES: readonly UsageSource[] = [claudeCodeSource];

export interface SourceStatus {
  id: string;
  displayName: string;
  installed: boolean;
  watching: boolean;
  paths: readonly string[];
  /** Why a detected source is not being watched. */
  detail?: string;
}

export interface SourceManagerOptions {
  onRecord: (record: UsageRecord) => void;
  log: (message: string) => void;
  /** Ignore history older than this on first run. */
  backfillSince?: Date;
  backfill: boolean;
}

/**
 * Detects installed tools and keeps a watcher per enabled source.
 *
 * Detection failures are contained per source: one tool that throws while being
 * probed must not stop the others from being watched, since the common cause is
 * a permissions quirk on one directory rather than anything systemic.
 */
export class SourceManager {
  private readonly watchers = new Map<string, SourceWatcher>();
  private readonly status = new Map<string, SourceStatus>();

  constructor(
    private readonly options: SourceManagerOptions,
    private readonly sources: readonly UsageSource[] = SOURCES,
  ) {}

  /**
   * Probe every source and start watching the enabled ones.
   * `enabled` is the user's per-source setting; an absent entry means on.
   */
  async start(enabled: Record<string, boolean>): Promise<void> {
    for (const source of this.sources) {
      const isEnabled = enabled[source.id] !== false;

      let detected;
      try {
        detected = await source.detect();
      } catch (error) {
        this.options.log(`${source.id}: detection failed: ${errorText(error)}`);
        this.status.set(source.id, {
          id: source.id,
          displayName: source.displayName,
          installed: false,
          watching: false,
          paths: [],
          detail: `Detection failed: ${errorText(error)}`,
        });
        continue;
      }

      if (!detected) {
        this.status.set(source.id, {
          id: source.id,
          displayName: source.displayName,
          installed: false,
          watching: false,
          paths: [],
          detail: "Not installed",
        });
        continue;
      }

      if (!isEnabled) {
        this.status.set(source.id, {
          id: source.id,
          displayName: source.displayName,
          installed: true,
          watching: false,
          paths: detected.paths,
          detail: "Disabled in settings",
        });
        continue;
      }

      try {
        const watcher = await source.watch({
          backfill: this.options.backfill,
          backfillSince: this.options.backfillSince,
          onRecord: this.options.onRecord,
          log: this.options.log,
        });
        this.watchers.set(source.id, watcher);
        this.status.set(source.id, {
          id: source.id,
          displayName: source.displayName,
          installed: true,
          watching: true,
          paths: detected.paths,
        });
        this.options.log(`${source.id}: watching (${detected.paths.join(", ")})`);
      } catch (error) {
        this.options.log(`${source.id}: could not start watching: ${errorText(error)}`);
        this.status.set(source.id, {
          id: source.id,
          displayName: source.displayName,
          installed: true,
          watching: false,
          paths: detected.paths,
          detail: `Could not start: ${errorText(error)}`,
        });
      }
    }
  }

  statuses(): readonly SourceStatus[] {
    return [...this.status.values()];
  }

  /** True when a tool was found but nothing is being watched. */
  hasInstalledButUnwatched(): boolean {
    return this.statuses().some((s) => s.installed && !s.watching);
  }

  dispose(): void {
    for (const watcher of this.watchers.values()) {
      try {
        watcher.dispose();
      } catch {
        // Disposal is best-effort; a failing watcher must not block the rest.
      }
    }
    this.watchers.clear();
    this.status.clear();
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
