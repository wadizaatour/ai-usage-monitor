import { strict as assert } from "node:assert";
import { test, describe } from "node:test";
import { anthropicAdapter, openaiAdapter, genericAdapter, parseUsage } from "../adapters/index.js";

const meta = { source: "test", now: () => new Date("2026-09-16T12:00:00.000Z") };

describe("anthropic adapter", () => {
  const response = {
    id: "msg_01ABC",
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
  };

  test("reads usage without adjusting input, which already excludes cache", () => {
    const record = anthropicAdapter.parse(response, meta);
    assert.equal(record.usage.inputTokens, 1200);
    assert.equal(record.usage.outputTokens, 350);
    assert.equal(record.usage.cachedTokens, 8000);
    assert.equal(record.usage.cacheWriteTokens, 400);
    assert.equal(record.model, "claude-opus-5");
    assert.equal(record.requestId, "msg_01ABC");
    assert.equal(record.status, "ok");
    assert.equal(record.usageUnavailable, false);
  });

  test("sums the per-TTL cache creation breakdown when there is no flat count", () => {
    const record = anthropicAdapter.parse(
      {
        ...response,
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 200 },
        },
      },
      meta,
    );
    assert.equal(record.usage.cacheWriteTokens, 300);
  });

  test("records a refusal as a completed request with its category", () => {
    const record = anthropicAdapter.parse(
      { ...response, stop_reason: "refusal", stop_details: { type: "refusal", category: "cyber" } },
      meta,
    );
    assert.equal(record.status, "ok");
    assert.equal(record.finishReason, "refusal:cyber");
  });

  test("flags a response that carried no usage block", () => {
    const record = anthropicAdapter.parse({ type: "message", role: "assistant", model: "x" }, meta);
    assert.equal(record.usageUnavailable, true);
    assert.equal(record.usage.inputTokens, undefined);
  });

  test("does not claim an OpenAI payload", () => {
    assert.equal(anthropicAdapter.detect({ object: "chat.completion", usage: { prompt_tokens: 1 } }), false);
  });
});

describe("openai adapter", () => {
  test("subtracts cached tokens so they are not billed twice", () => {
    const record = openaiAdapter.parse(
      {
        id: "chatcmpl-1",
        object: "chat.completion",
        model: "gpt-x",
        choices: [{ finish_reason: "stop" }],
        usage: {
          prompt_tokens: 10_000, // inclusive of the 8000 cached
          completion_tokens: 500,
          total_tokens: 10_500,
          prompt_tokens_details: { cached_tokens: 8000 },
        },
      },
      meta,
    );
    assert.equal(record.usage.inputTokens, 2000);
    assert.equal(record.usage.cachedTokens, 8000);
    // The provider's own total stays inclusive.
    assert.equal(record.usage.totalTokens, 10_500);
    assert.equal(record.finishReason, "stop");
  });

  test("reads the Responses API field names", () => {
    const record = openaiAdapter.parse(
      {
        id: "resp_1",
        object: "response",
        model: "o-x",
        usage: {
          input_tokens: 500,
          output_tokens: 900,
          total_tokens: 1400,
          output_tokens_details: { reasoning_tokens: 700 },
        },
      },
      meta,
    );
    assert.equal(record.usage.inputTokens, 500);
    assert.equal(record.usage.outputTokens, 900);
    // Reasoning is a subset of output, so output is not increased by it.
    assert.equal(record.usage.reasoningTokens, 700);
  });

  test("never lets a subtraction go negative", () => {
    const record = openaiAdapter.parse(
      { object: "chat.completion", model: "m", usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 500 } } },
      meta,
    );
    assert.equal(record.usage.inputTokens, 0);
  });
});

describe("generic adapter", () => {
  test("reads the documented envelope shape", () => {
    const record = genericAdapter.parse(
      {
        provider: "my-proxy",
        model: "claude-sonnet-5",
        durationMs: 812,
        usage: { inputTokens: 100, outputTokens: 20, cachedTokens: 900 },
      },
      meta,
    );
    assert.equal(record.provider, "my-proxy");
    assert.equal(record.durationMs, 812);
    assert.equal(record.usage.cachedTokens, 900);
  });

  test("infers error status from an error message", () => {
    const record = genericAdapter.parse({ model: "m", errorMessage: "rate limited" }, meta);
    assert.equal(record.status, "error");
  });
});

describe("parseUsage dispatch", () => {
  test("routes each payload to its vendor adapter", () => {
    assert.equal(parseUsage({ type: "message", role: "assistant", model: "m" }, meta)?.provider, "anthropic");
    assert.equal(parseUsage({ object: "chat.completion", model: "m" }, meta)?.provider, "openai");
  });

  test("falls back to generic, and returns undefined when nothing matches", () => {
    assert.equal(parseUsage({ model: "m", usage: { inputTokens: 1 } }, meta)?.provider, "generic");
    assert.equal(parseUsage({ unrelated: true }, meta), undefined);
    assert.equal(parseUsage("not an object", meta), undefined);
  });

  test("meta.provider overrides the adapter id, for proxied calls", () => {
    const record = parseUsage({ type: "message", role: "assistant", model: "m" }, { ...meta, provider: "litellm" });
    assert.equal(record?.provider, "litellm");
  });

  test("rejects coercible-but-wrong token types instead of guessing", () => {
    const record = parseUsage(
      { type: "message", role: "assistant", model: "m", usage: { input_tokens: "1200", output_tokens: 3.5 } },
      meta,
    );
    assert.equal(record?.usage.inputTokens, undefined);
    assert.equal(record?.usage.outputTokens, undefined);
  });
});
