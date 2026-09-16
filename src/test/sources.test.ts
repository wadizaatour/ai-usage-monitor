import { strict as assert } from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { JsonlTailer } from "../sources/jsonl-tail.js";
import { SourceManager } from "../sources/index.js";
import type { UsageSource } from "../sources/types.js";
import type { UsageRecord } from "../types.js";

const settle = (ms = 220) => new Promise((resolve) => setTimeout(resolve, ms));

describe("JsonlTailer", () => {
  let dir: string;
  let file: string;

  beforeEach(async () => {
    dir = await fsp.mkdtemp(path.join(os.tmpdir(), "aium-"));
    file = path.join(dir, "session.jsonl");
  });

  afterEach(async () => {
    await fsp.rm(dir, { recursive: true, force: true });
  });

  test("emits each complete line once and resumes from the offset", async () => {
    await fsp.writeFile(file, '{"n":1}\n{"n":2}\n');
    const seen: unknown[] = [];
    const tailer = new JsonlTailer({ onLine: (v) => seen.push(v), log: () => {} });

    await tailer.track(file);
    await settle();
    assert.deepEqual(seen, [{ n: 1 }, { n: 2 }]);

    // An append yields only the new line, not the whole file again.
    await fsp.appendFile(file, '{"n":3}\n');
    tailer.schedule(file);
    await settle();
    assert.deepEqual(seen, [{ n: 1 }, { n: 2 }, { n: 3 }]);

    tailer.dispose();
  });

  test("holds a partial line until its newline arrives", async () => {
    await fsp.writeFile(file, '{"n":1}\n{"partial":');
    const seen: unknown[] = [];
    const tailer = new JsonlTailer({ onLine: (v) => seen.push(v), log: () => {} });

    await tailer.track(file);
    await settle();
    // The half-written record must not be parsed or dropped.
    assert.deepEqual(seen, [{ n: 1 }]);

    await fsp.appendFile(file, "true}\n");
    tailer.schedule(file);
    await settle();
    assert.deepEqual(seen, [{ n: 1 }, { partial: true }]);

    tailer.dispose();
  });

  test("re-reads from the start when the file is truncated", async () => {
    await fsp.writeFile(file, '{"n":1}\n{"n":2}\n');
    const seen: unknown[] = [];
    const tailer = new JsonlTailer({ onLine: (v) => seen.push(v), log: () => {} });

    await tailer.track(file);
    await settle();
    assert.equal(seen.length, 2);

    // Rotation/reset: a smaller file means new content, not a seek target.
    await fsp.writeFile(file, '{"fresh":true}\n');
    tailer.schedule(file);
    await settle();
    assert.deepEqual(seen[seen.length - 1], { fresh: true });

    tailer.dispose();
  });

  test("skips malformed lines without stopping the tail", async () => {
    await fsp.writeFile(file, '{"ok":1}\nnot json at all\n{"ok":2}\n');
    const seen: unknown[] = [];
    const tailer = new JsonlTailer({ onLine: (v) => seen.push(v), log: () => {} });

    await tailer.track(file);
    await settle();
    assert.deepEqual(seen, [{ ok: 1 }, { ok: 2 }]);

    tailer.dispose();
  });

  test("fromEnd skips existing content", async () => {
    await fsp.writeFile(file, '{"old":1}\n');
    const seen: unknown[] = [];
    const tailer = new JsonlTailer({ onLine: (v) => seen.push(v), log: () => {}, fromEnd: true });

    await tailer.track(file);
    await settle();
    assert.deepEqual(seen, []);

    await fsp.appendFile(file, '{"new":1}\n');
    tailer.schedule(file);
    await settle();
    assert.deepEqual(seen, [{ new: 1 }]);

    tailer.dispose();
  });
});

describe("SourceManager", () => {
  const fakeSource = (over: Partial<UsageSource> = {}): UsageSource => ({
    id: "fake",
    displayName: "Fake Tool",
    detect: async () => ({ paths: ["/somewhere"] }),
    watch: async () => ({ id: "fake", dispose: () => {} }),
    ...over,
  });

  const manager = (sources: UsageSource[], records: UsageRecord[] = []) =>
    new SourceManager({ backfill: true, onRecord: (r) => records.push(r), log: () => {} }, sources);

  test("watches a detected source", async () => {
    const m = manager([fakeSource()]);
    await m.start({});
    assert.deepEqual(m.statuses(), [
      { id: "fake", displayName: "Fake Tool", installed: true, watching: true, paths: ["/somewhere"] },
    ]);
    m.dispose();
  });

  test("reports an undetected tool as not installed", async () => {
    const m = manager([fakeSource({ detect: async () => undefined })]);
    await m.start({});
    const [status] = m.statuses();
    assert.equal(status.installed, false);
    assert.equal(status.watching, false);
    m.dispose();
  });

  test("respects a disabled source without probing it further", async () => {
    let watched = false;
    const m = manager([
      fakeSource({
        watch: async () => {
          watched = true;
          return { id: "fake", dispose: () => {} };
        },
      }),
    ]);
    await m.start({ fake: false });
    assert.equal(watched, false);
    assert.equal(m.statuses()[0].detail, "Disabled in settings");
    m.dispose();
  });

  test("one failing source does not prevent the others from being watched", async () => {
    const m = manager([
      fakeSource({
        id: "broken",
        detect: async () => {
          throw new Error("permission denied");
        },
      }),
      fakeSource({ id: "healthy" }),
    ]);
    await m.start({});

    const byId = new Map(m.statuses().map((s) => [s.id, s]));
    assert.equal(byId.get("broken")?.watching, false);
    assert.match(byId.get("broken")?.detail ?? "", /permission denied/);
    // The whole point: an unrelated failure must not take down detection.
    assert.equal(byId.get("healthy")?.watching, true);
    m.dispose();
  });

  test("surfaces a tool that is installed but not being watched", async () => {
    const m = manager([
      fakeSource({
        watch: async () => {
          throw new Error("watch limit reached");
        },
      }),
    ]);
    await m.start({});
    assert.equal(m.hasInstalledButUnwatched(), true);
    m.dispose();
  });
});
