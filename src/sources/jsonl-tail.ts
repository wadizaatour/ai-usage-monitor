import * as fs from "node:fs";
import * as fsp from "node:fs/promises";

/**
 * Follows append-only JSONL files and yields each complete line exactly once.
 *
 * The problems this solves, all of which show up immediately when tailing a
 * file another process is actively writing:
 *
 *   - A read can land mid-line. Partial tails are buffered and only parsed
 *     once their newline arrives, so a half-written record is never dropped
 *     or double-counted.
 *   - Reads must resume from an offset, not re-read the file. Re-reading a
 *     multi-megabyte transcript on every change would both stall the
 *     extension host and re-emit every record.
 *   - A file can be truncated or replaced (log rotation, a session reset).
 *     A size smaller than the offset means the file is new, so the offset
 *     resets rather than seeking past the end and going silent forever.
 *   - Writes arrive in bursts. Reads are coalesced behind a short debounce so
 *     a rapid sequence of appends causes one read, not dozens.
 *
 * A line that fails to parse is skipped and counted, never thrown: one corrupt
 * record must not stop the tail of an otherwise healthy file.
 */

const DEBOUNCE_MS = 120;

export interface TailOptions {
  onLine: (value: unknown, file: string) => void;
  log: (message: string) => void;
  /** Start at EOF instead of reading existing content. */
  fromEnd?: boolean;
}

export class JsonlTailer {
  private readonly offsets = new Map<string, number>();
  private readonly pending = new Map<string, string>();
  private readonly timers = new Map<string, NodeJS.Timeout>();
  private readonly reading = new Set<string>();
  private readonly queued = new Set<string>();
  private disposed = false;
  private malformed = 0;

  constructor(private readonly options: TailOptions) {}

  /**
   * Track a file. With `fromEnd`, seeks to the current size so existing
   * content is skipped — used when backfill is off.
   */
  async track(file: string): Promise<void> {
    if (this.disposed || this.offsets.has(file)) {
      return;
    }
    let start = 0;
    if (this.options.fromEnd) {
      try {
        start = (await fsp.stat(file)).size;
      } catch {
        start = 0;
      }
    }
    this.offsets.set(file, start);
    this.schedule(file);
  }

  /** Note a change. Debounced, so a burst of appends causes one read. */
  schedule(file: string): void {
    if (this.disposed) {
      return;
    }
    if (!this.offsets.has(file)) {
      void this.track(file);
      return;
    }
    const existing = this.timers.get(file);
    if (existing) {
      clearTimeout(existing);
    }
    this.timers.set(
      file,
      setTimeout(() => {
        this.timers.delete(file);
        void this.read(file);
      }, DEBOUNCE_MS),
    );
  }

  forget(file: string): void {
    this.offsets.delete(file);
    this.pending.delete(file);
    const timer = this.timers.get(file);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(file);
    }
  }

  dispose(): void {
    this.disposed = true;
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    this.offsets.clear();
    this.pending.clear();
    if (this.malformed > 0) {
      this.options.log(`skipped ${this.malformed} malformed line(s) while tailing`);
    }
  }

  private async read(file: string): Promise<void> {
    if (this.disposed) {
      return;
    }
    // One read per file at a time; a change arriving mid-read queues a rerun
    // rather than interleaving two reads over the same offset.
    if (this.reading.has(file)) {
      this.queued.add(file);
      return;
    }
    this.reading.add(file);

    try {
      await this.readOnce(file);
    } catch (error) {
      // A file can vanish between the watch event and the read.
      if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
        this.options.log(`tail failed for ${file}: ${errorText(error)}`);
      }
    } finally {
      this.reading.delete(file);
      if (this.queued.delete(file) && !this.disposed) {
        this.schedule(file);
      }
    }
  }

  private async readOnce(file: string): Promise<void> {
    const offset = this.offsets.get(file) ?? 0;
    const { size } = await fsp.stat(file);

    if (size === offset) {
      return;
    }

    // Truncated or replaced: start over rather than seeking past the end.
    if (size < offset) {
      this.options.log(`${file} shrank; re-reading from the start`);
      this.offsets.set(file, 0);
      this.pending.delete(file);
      return this.readOnce(file);
    }

    const handle = await fsp.open(file, "r");
    let chunk: string;
    try {
      const length = size - offset;
      const buffer = Buffer.allocUnsafe(length);
      const { bytesRead } = await handle.read(buffer, 0, length, offset);
      chunk = buffer.subarray(0, bytesRead).toString("utf8");
      this.offsets.set(file, offset + bytesRead);
    } finally {
      await handle.close();
    }

    const text = (this.pending.get(file) ?? "") + chunk;
    const lines = text.split("\n");
    // The last element is whatever follows the final newline: either "" or a
    // partial line still being written. Hold it until its newline arrives.
    const tail = lines.pop() ?? "";
    this.pending.set(file, tail);

    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length === 0) {
        continue;
      }
      try {
        this.options.onLine(JSON.parse(trimmed), file);
      } catch {
        this.malformed += 1;
      }
    }
  }
}

/** Does this path exist and is it readable? */
export async function exists(target: string): Promise<boolean> {
  try {
    await fsp.access(target, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
