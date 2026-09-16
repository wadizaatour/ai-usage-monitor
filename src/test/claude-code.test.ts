import { strict as assert } from "node:assert";
import { test, describe, beforeEach, afterEach } from "node:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { claudeCodeSource } from "../sources/claude-code.js";
import type { UsageRecord } from "../types.js";

/**
 * Drives the real source against a fake ~/.claude tree via CLAUDE_CONFIG_DIR,
 * so the transcript shape and the watch path are both exercised without
 * touching the user's actual sessions.
 */
describe("claude-code source", () => {
  let root: string;
  let projectDir: string;
  let original: string | undefined;

  const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, ms));

  beforeEach(async () => {
    root = await fsp.mkdtemp(path.join(os.tmpdir(), "aium-cc-"));
    projectDir = path.join(root, "projects", "my-project");
    await fsp.mkdir(projectDir, { recursive: true });
    original = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = root;
  });

  afterEach(async () => {
    if (original === undefined) {
      delete process.env.CLAUDE_CONFIG_DIR;
    } else {
      process.env.CLAUDE_CONFIG_DIR = original;
    }
    await fsp.rm(root, { recursive: true, force: true });
  });

  /**
   * One assistant turn as Claude Code writes it: message is the API response.
   * `message` overrides merge into the message; anything else overrides the
   * top-level line.
   */
  const assistantLine = (over: { message?: Record<string, unknown> } & Record<string, unknown> = {}) => {
    const { message: messageOver, ...lineOver } = over;
    return (
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        ...lineOver,
        message: {
          id: "msg_01TEST",
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          stop_reason: "end_turn",
          usage: {
            input_tokens: 1200,
            output_tokens: 350,
            cache_read_input_tokens: 8000,
            cache_creation_input_tokens: 400,
          },
          ...messageOver,
        },
      }) + "\n"
    );
  };

  test("detects an installed Claude Code", async () => {
    const detected = await claudeCodeSource.detect();
    assert.ok(detected);
    assert.ok(detected.paths[0].includes("projects"));
  });

  test("reports not installed when the directory is absent", async () => {
    process.env.CLAUDE_CONFIG_DIR = path.join(root, "does-not-exist");
    assert.equal(await claudeCodeSource.detect(), undefined);
  });

  test("detects a fresh install that has not been used yet", async () => {
    // No projects/ directory: installed but idle must still detect, or a
    // working install looks broken until its first request.
    await fsp.rm(path.join(root, "projects"), { recursive: true, force: true });
    const detected = await claudeCodeSource.detect();
    assert.ok(detected, "a fresh install should still be detected");
  });

  test("parses a transcript turn into a record via the anthropic adapter", async () => {
    await fsp.writeFile(path.join(projectDir, "session.jsonl"), assistantLine());

    const records: UsageRecord[] = [];
    const watcher = await claudeCodeSource.watch({
      backfill: true,
      onRecord: (r) => records.push(r),
      log: () => {},
    });
    await settle();
    watcher.dispose();

    assert.equal(records.length, 1);
    const [record] = records;
    assert.equal(record.model, "claude-opus-5");
    assert.equal(record.provider, "anthropic");
    assert.equal(record.source, "claude-code");
    assert.equal(record.requestId, "msg_01TEST");
    // Token accounting comes from the shared adapter, not a second copy.
    assert.equal(record.usage.inputTokens, 1200);
    assert.equal(record.usage.cachedTokens, 8000);
    assert.equal(record.usage.cacheWriteTokens, 400);
  });

  test("picks up a turn appended while watching", async () => {
    const file = path.join(projectDir, "live.jsonl");
    await fsp.writeFile(file, "");

    const records: UsageRecord[] = [];
    const watcher = await claudeCodeSource.watch({
      backfill: true,
      onRecord: (r) => records.push(r),
      log: () => {},
    });
    await settle(150);

    await fsp.appendFile(file, assistantLine({ message: { id: "msg_LIVE" } }));
    // Long enough to cover a poll cycle: fs.watch delivers nothing on some
    // Windows paths, so the poll is what must carry this.
    await settle(5000);
    watcher.dispose();

    assert.equal(records.length, 1, "a live append should produce a record");
    assert.equal(records[0].requestId, "msg_LIVE");
  });

  test("ignores user turns and lines with no usage", async () => {
    await fsp.writeFile(
      path.join(projectDir, "mixed.jsonl"),
      JSON.stringify({ type: "user", message: { role: "user", content: "secret prompt" } }) +
        "\n" +
        JSON.stringify({ type: "assistant", message: { id: "x", role: "assistant", model: "m" } }) +
        "\n" +
        assistantLine(),
    );

    const records: UsageRecord[] = [];
    const watcher = await claudeCodeSource.watch({
      backfill: true,
      onRecord: (r) => records.push(r),
      log: () => {},
    });
    await settle();
    watcher.dispose();

    assert.equal(records.length, 1);
  });

  test("never carries prompt or response text into a record", async () => {
    await fsp.writeFile(
      path.join(projectDir, "texty.jsonl"),
      JSON.stringify({
        type: "assistant",
        timestamp: new Date().toISOString(),
        message: {
          id: "msg_TEXT",
          role: "assistant",
          model: "claude-opus-5",
          content: [{ type: "text", text: "SENSITIVE-RESPONSE-BODY" }],
          usage: { input_tokens: 10, output_tokens: 5 },
        },
      }) + "\n",
    );

    const records: UsageRecord[] = [];
    const watcher = await claudeCodeSource.watch({
      backfill: true,
      onRecord: (r) => records.push(r),
      log: () => {},
    });
    await settle();
    watcher.dispose();

    assert.equal(records.length, 1);
    // The whole record, serialized, must not contain the conversation text.
    assert.ok(!JSON.stringify(records[0]).includes("SENSITIVE-RESPONSE-BODY"));
  });

  test("skips turns older than the backfill cutoff", async () => {
    const old = JSON.stringify({
      type: "assistant",
      timestamp: new Date("2020-01-01T00:00:00Z").toISOString(),
      message: {
        id: "msg_OLD",
        role: "assistant",
        model: "claude-opus-5",
        usage: { input_tokens: 1, output_tokens: 1 },
      },
    }) + "\n";
    await fsp.writeFile(path.join(projectDir, "old.jsonl"), old + assistantLine());

    const records: UsageRecord[] = [];
    const watcher = await claudeCodeSource.watch({
      backfill: true,
      backfillSince: new Date(Date.now() - 60_000),
      onRecord: (r) => records.push(r),
      log: () => {},
    });
    await settle();
    watcher.dispose();

    assert.deepEqual(
      records.map((r) => r.requestId),
      ["msg_01TEST"],
    );
  });

  test("emits a repeated message id only once", async () => {
    // A resumed session replays earlier turns; the same request must not be
    // counted twice.
    await fsp.writeFile(path.join(projectDir, "dupe.jsonl"), assistantLine() + assistantLine());

    const records: UsageRecord[] = [];
    const watcher = await claudeCodeSource.watch({
      backfill: true,
      onRecord: (r) => records.push(r),
      log: () => {},
    });
    await settle();
    watcher.dispose();

    assert.equal(records.length, 1);
  });
});
