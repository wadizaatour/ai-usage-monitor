import { strict as assert } from "node:assert";
import { test, describe, before, after } from "node:test";
import { startIngestServer, type IngestHandle } from "../ingest.js";
import type { UsageRecord } from "../types.js";

/**
 * These exercise the security boundary — auth, method/path, and the body cap —
 * against a real socket, because that is where the guarantees actually live.
 * Port 0 lets the OS pick a free port so the suite never collides with a
 * running extension host.
 */
describe("ingest server", () => {
  let server: IngestHandle;
  let received: UsageRecord[] = [];

  before(async () => {
    server = await startIngestServer({
      port: 0,
      onRecord: (record) => received.push(record),
      log: () => {},
    });
  });

  after(async () => {
    await server.close();
  });

  const post = (body: string, headers: Record<string, string> = {}, path = "/usage") =>
    fetch(`http://127.0.0.1:${server.port}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body,
    });

  const authed = () => ({ authorization: `Bearer ${server.token}` });

  test("records a valid authenticated payload", async () => {
    received = [];
    const response = await post(
      JSON.stringify({
        durationMs: 1234,
        response: {
          type: "message",
          role: "assistant",
          model: "claude-opus-5",
          usage: { input_tokens: 1200, output_tokens: 350 },
        },
      }),
      authed(),
    );

    assert.equal(response.status, 200);
    assert.equal(received.length, 1);
    assert.equal(received[0].model, "claude-opus-5");
    assert.equal(received[0].usage.inputTokens, 1200);
    // The envelope supplies what the response body cannot.
    assert.equal(received[0].durationMs, 1234);
    assert.equal(received[0].source, "ingest");
  });

  test("accepts a bare provider response with no envelope", async () => {
    received = [];
    const response = await post(
      JSON.stringify({ object: "chat.completion", model: "gpt-x", usage: { prompt_tokens: 5, completion_tokens: 2 } }),
      authed(),
    );
    assert.equal(response.status, 200);
    assert.equal(received[0].provider, "openai");
  });

  test("rejects a missing, malformed, or wrong token", async () => {
    received = [];
    const cases: Array<Record<string, string>> = [
      {},
      { authorization: "Basic xyz" },
      { authorization: "Bearer wrong" },
    ];
    for (const headers of cases) {
      const response = await post(JSON.stringify({ model: "m" }), headers);
      assert.equal(response.status, 401);
    }
    assert.equal(received.length, 0);
  });

  test("rejects a token of the right length but wrong value", async () => {
    // Guards the constant-time comparison's length pre-check.
    const sameLength = "f".repeat(server.token.length);
    const response = await post(JSON.stringify({ model: "m" }), { authorization: `Bearer ${sameLength}` });
    assert.equal(response.status, 401);
  });

  test("rejects other methods and unknown paths", async () => {
    assert.equal((await post("{}", authed(), "/other")).status, 404);
    const get = await fetch(`http://127.0.0.1:${server.port}/usage`, { method: "GET" });
    assert.equal(get.status, 405);
  });

  test("rejects invalid JSON and unrecognized payloads distinctly", async () => {
    assert.equal((await post("{not json", authed())).status, 400);
    assert.equal((await post(JSON.stringify({ unrelated: true }), authed())).status, 422);
  });

  test("caps the body so a runaway caller cannot exhaust memory", async () => {
    const huge = JSON.stringify({ model: "m", pad: "x".repeat(300 * 1024) });
    // Either a 413 or a transport-level abort is acceptable — both mean the
    // server refused to buffer it. What must not happen is a 200.
    let status: number | "aborted";
    try {
      status = (await post(huge, authed())).status;
    } catch {
      status = "aborted";
    }
    assert.notEqual(status, 200);
  });
});
