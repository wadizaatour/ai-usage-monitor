import * as os from "node:os";
import * as path from "node:path";
import * as fsp from "node:fs/promises";
import * as fs from "node:fs";
import type { UsageRecord } from "../types.js";
import type { DetectedSource, SourceWatcher, UsageSource, WatchOptions } from "./types.js";
import { JsonlTailer, exists } from "./jsonl-tail.js";
import { anthropicAdapter } from "../adapters/anthropic.js";

/**
 * Claude Code.
 *
 * Claude Code appends a JSONL transcript per session under
 * `~/.claude/projects/<encoded-cwd>/<session-id>.jsonl`. Each assistant turn is
 * a line whose `message` is the raw Anthropic API response, `usage` block and
 * all — so the existing Anthropic adapter parses it directly and there is no
 * second, drifting copy of the token-accounting rules.
 *
 * Read-only, and deliberately narrow: only `message.usage` and the few fields
 * around it are read. Prompt and response *text* sit in the same lines and are
 * never touched, so nothing the user typed can reach the history or an export.
 *
 * Costs are not taken from the transcript even when present. They are
 * recomputed from the verified pricing table like every other record, so one
 * set of rules produces every number the extension displays.
 */

const HOME_DIR = ".claude";
const PROJECTS_DIR = "projects";

/**
 * Rescan cadence for the polling fallback. Slow enough to be invisible in CPU
 * terms, fast enough that a request shows up while you are still looking at it.
 */
const POLL_INTERVAL_MS = 4000;

/** Honors CLAUDE_CONFIG_DIR, which relocates the whole directory. */
function claudeRoot(): string {
  const override = process.env.CLAUDE_CONFIG_DIR;
  return override && override.length > 0 ? override : path.join(os.homedir(), HOME_DIR);
}

export const claudeCodeSource: UsageSource = {
  id: "claude-code",
  displayName: "Claude Code",

  async detect(): Promise<DetectedSource | undefined> {
    const root = claudeRoot();
    if (!(await exists(root))) {
      return undefined;
    }

    const projects = path.join(root, PROJECTS_DIR);
    // The projects directory appears on first use. Its absence means installed
    // but not yet used, which is still "installed" — reporting undefined here
    // would make a working install look missing until its first request.
    return { paths: [(await exists(projects)) ? projects : root] };
  },

  async watch(options: WatchOptions): Promise<SourceWatcher> {
    const projects = path.join(claudeRoot(), PROJECTS_DIR);
    const seen = new Set<string>();

    const tailer = new JsonlTailer({
      fromEnd: !options.backfill,
      log: options.log,
      onLine: (value, file) => {
        const record = toRecord(value, file, options.backfillSince, seen);
        if (record) {
          options.onRecord(record);
        }
      },
    });

    // Recursive watch covers both new session files inside existing project
    // directories and entirely new project directories.
    let watcher: fs.FSWatcher | undefined;

    const startWatching = async (): Promise<void> => {
      if (!(await exists(projects))) {
        return;
      }
      for (const file of await findTranscripts(projects, options.backfillSince)) {
        await tailer.track(file);
      }

      // Watch the canonical path. On Windows, recursive fs.watch on a path
      // containing 8.3 short names (C:\Users\WADI~1.ZAA\...) trips a libuv
      // assertion that aborts the *process* — it cannot be caught, so it must
      // be avoided. realpath expands those to their long form.
      let watchPath = projects;
      try {
        watchPath = await fsp.realpath(projects);
      } catch {
        // Keep the original path; the try below still guards a normal failure.
      }

      // Recursive watch is unsupported on some platforms and filesystems
      // (older Linux kernels, network shares). Fall back rather than losing
      // the feature outright.
      try {
        watcher = fs.watch(watchPath, { recursive: true }, (_event, filename) => {
          if (typeof filename === "string" && filename.endsWith(".jsonl")) {
            tailer.schedule(path.join(watchPath, filename));
          }
        });
        watcher.on("error", (error) => {
          options.log(`claude-code: watch error, falling back to polling: ${errorText(error)}`);
          watcher?.close();
          watcher = undefined;
          startPolling();
        });
      } catch (error) {
        options.log(`claude-code: cannot watch ${watchPath}, polling instead: ${errorText(error)}`);
        startPolling();
      }
    };

    // Rescan on a timer.
    //
    // This runs *alongside* the native watch rather than only as a fallback,
    // because fs.watch can fail silently as well as loudly: on Windows it
    // delivers no events at all for some paths (8.3 short names, network
    // shares, certain virtualized directories) while still reporting success.
    // A watch that quietly never fires is indistinguishable from an idle tool,
    // which is exactly the "nothing shows up" failure this feature exists to
    // avoid — so correctness rests on the poll and the watch only makes it
    // faster. Rescanning is cheap: the tailer reads from each file's last
    // offset, so a pass over unchanged files does almost no work.
    let poll: NodeJS.Timeout | undefined;
    const startPolling = (): void => {
      if (poll) {
        return;
      }
      poll = setInterval(() => {
        void (async () => {
          if (!(await exists(projects))) {
            return;
          }
          for (const file of await findTranscripts(projects, options.backfillSince)) {
            await tailer.track(file);
            tailer.schedule(file);
          }
        })();
      }, POLL_INTERVAL_MS);
      poll.unref?.();
    };

    await startWatching();
    startPolling();

    return {
      id: claudeCodeSource.id,
      dispose: () => {
        if (poll) {
          clearInterval(poll);
          poll = undefined;
        }
        watcher?.close();
        watcher = undefined;
        tailer.dispose();
      },
    };
  },
};

/**
 * Turn one transcript line into a record, or undefined when the line is not a
 * billable assistant turn.
 */
function toRecord(
  value: unknown,
  file: string,
  since: Date | undefined,
  seen: Set<string>,
): UsageRecord | undefined {
  if (!isRecord(value) || value.type !== "assistant") {
    return undefined;
  }

  const message = isRecord(value.message) ? value.message : undefined;
  if (!message || !isRecord(message.usage)) {
    return undefined;
  }

  const timestamp = typeof value.timestamp === "string" ? new Date(value.timestamp) : undefined;
  const when = timestamp && !Number.isNaN(timestamp.getTime()) ? timestamp : new Date();

  if (since && when < since) {
    return undefined;
  }

  // A streamed turn can be written more than once as it is revised, and a
  // resumed session replays earlier lines. The API's own message id is the
  // stable identity, so dedupe on it rather than on file position.
  const messageId = typeof message.id === "string" ? message.id : undefined;
  const key = messageId ?? `${file}:${when.getTime()}`;
  if (seen.has(key)) {
    return undefined;
  }
  seen.add(key);

  // The transcript's message IS an Anthropic API response, so the existing
  // adapter parses it — no duplicate token-accounting logic here.
  const record = anthropicAdapter.parse(message, {
    source: claudeCodeSource.id,
    provider: "anthropic",
    now: () => when,
  });

  return {
    ...record,
    // Prefer the API's request id over the locally-generated one.
    requestId: messageId ?? record.requestId,
  };
}

/** Every `.jsonl` under the projects tree, newest first. */
async function findTranscripts(root: string, since: Date | undefined): Promise<string[]> {
  const found: Array<{ file: string; mtimeMs: number }> = [];

  const walk = async (dir: string, depth: number): Promise<void> => {
    // Transcripts live at projects/<project>/<session>.jsonl. A small depth cap
    // keeps a symlinked or unexpectedly deep tree from becoming a long scan.
    if (depth > 3) {
      return;
    }
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const stat = await fsp.stat(full);
          // Skip whole files that predate the cutoff — far cheaper than
          // parsing every line only to discard it.
          if (since && stat.mtime < since) {
            continue;
          }
          found.push({ file: full, mtimeMs: stat.mtimeMs });
        } catch {
          // Raced with a delete; skip.
        }
      }
    }
  };

  await walk(root, 0);
  return found.sort((a, b) => b.mtimeMs - a.mtimeMs).map((f) => f.file);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
