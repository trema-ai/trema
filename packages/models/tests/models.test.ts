import { RunEventDataSchema } from "@trema/harness";
import type { RunEventData, ToolDef, TurnRequest, Usage } from "@trema/harness";
import type { LanguageModelUsage, TextStreamPart } from "ai";
import { describe, expect, it, vi } from "vitest";

import { createSdkModelPort } from "../src/index.js";
import { createSdkModelPortWithOperations } from "../src/sdk-model-port.js";
import type { SdkCallOptions, SdkOperations } from "../src/sdk-operations.js";
import { toModelMessages } from "../src/to-model-messages.js";

type Part = TextStreamPart<any>;

const sdkUsage: LanguageModelUsage = {
  inputTokens: 11,
  inputTokenDetails: { noCacheTokens: 7, cacheReadTokens: 3, cacheWriteTokens: 1 },
  outputTokens: 5,
  outputTokenDetails: { textTokens: 5, reasoningTokens: 0 },
  totalTokens: 16,
  raw: { costUsd: 0.004 },
};

const usage: Usage = {
  inputTokens: 11,
  outputTokens: 5,
  totalTokens: 16,
  cacheReadTokens: 3,
  cacheWriteTokens: 1,
  costUsd: 0.004,
};

const endpoints = {
  primary: {
    protocol: "openai-compatible" as const,
    baseUrl: "https://models.example.test/v1",
    apiKey: "primary-secret",
  },
};

const lookup: ToolDef = {
  name: "lookup",
  title: "Knowledge lookup",
  description: "Look up a fact",
  schema: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  kind: "search",
};

function request(overrides: Partial<TurnRequest> = {}): TurnRequest {
  return {
    model: { id: "reasoning-model" },
    instructions: "Be useful.",
    messages: [{ role: "user", blocks: [{ type: "text", text: "Hello" }] }],
    tools: [],
    abort: new AbortController().signal,
    ...overrides,
  };
}

function finish(reason: "stop" | "tool-calls" | "length" = "stop"): Part {
  return { type: "finish", finishReason: reason, rawFinishReason: reason, totalUsage: sdkUsage };
}

function operations(parts: readonly Part[] | AsyncIterable<Part>): {
  sdk: SdkOperations;
  calls: SdkCallOptions[];
} {
  const calls: SdkCallOptions[] = [];
  return {
    calls,
    sdk: {
      stream(options) {
        calls.push(options);
        return {
          fullStream: Symbol.asyncIterator in parts
            ? parts
            : (async function* () { yield* parts; })(),
        };
      },
      async generate(options) {
        calls.push(options);
        return { text: "short answer", usage: sdkUsage };
      },
    },
  };
}

async function collect(parts: readonly Part[], overrides: Partial<TurnRequest> = {}) {
  const fixture = operations(parts);
  const port = createSdkModelPortWithOperations({ endpoints }, fixture.sdk);
  const stream = port.streamTurn(request(overrides));
  const events: RunEventData[] = [];
  for await (const event of stream) events.push(event);
  return { events, result: await stream.result, calls: fixture.calls };
}

function expectValid(events: readonly RunEventData[]): void {
  for (const event of events) expect(RunEventDataSchema.safeParse(event).success).toBe(true);
}

describe("SDK full-stream golden transcripts", () => {
  it("maps a text turn and usage", async () => {
    const actual = await collect([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "Hello there" },
      { type: "text-end", id: "text-1" },
      finish(),
    ]);

    expect(actual.events).toEqual([
      { type: "text-start", blockId: "text-1" },
      { type: "text-delta", blockId: "text-1", delta: "Hello there" },
      { type: "text-end", blockId: "text-1" },
    ]);
    expect(actual.result).toEqual({
      message: { role: "assistant", blocks: [{ type: "text", text: "Hello there" }] },
      toolCalls: [],
      stopReason: "stop",
      usage,
    });
    expectValid(actual.events);
  });

  it("keeps reasoning before text and preserves block metadata", async () => {
    const signature = { primary: { signature: "opaque-signature" } };
    const actual = await collect([
      { type: "reasoning-start", id: "reason-1" },
      { type: "reasoning-delta", id: "reason-1", text: "Consider" },
      { type: "reasoning-end", id: "reason-1", providerMetadata: signature },
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "Answer" },
      { type: "text-end", id: "text-1" },
      finish(),
    ]);

    expect(actual.events.map((event) => event.type)).toEqual([
      "reasoning-start", "reasoning-delta", "reasoning-end",
      "text-start", "text-delta", "text-end",
    ]);
    expect(actual.result.message.blocks).toEqual([
      { type: "thinking", text: "Consider", providerMeta: signature },
      { type: "text", text: "Answer" },
    ]);
    expectValid(actual.events);
  });

  it("maps a validated tool call using the request registry", async () => {
    const actual = await collect([
      { type: "tool-input-start", id: "call-1", toolName: "lookup" },
      { type: "tool-input-delta", id: "call-1", delta: "{\"q\":" },
      { type: "tool-input-delta", id: "call-1", delta: "\"trema\"}" },
      { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { q: "trema" } },
      finish("tool-calls"),
    ], { tools: [lookup] });

    expect(actual.events).toEqual([
      { type: "tool-start", callId: "call-1", name: "lookup", title: "Knowledge lookup", kind: "search" },
      { type: "tool-input-delta", callId: "call-1", delta: "{\"q\":" },
      { type: "tool-input-delta", callId: "call-1", delta: "\"trema\"}" },
      { type: "tool-input", callId: "call-1", input: { q: "trema" } },
    ]);
    expect(actual.result.stopReason).toBe("toolUse");
    expect(actual.result.toolCalls).toEqual([{ callId: "call-1", name: "lookup", input: { q: "trema" } }]);
    expectValid(actual.events);
  });

  it("keeps parallel tool streams distinct and interleaved", async () => {
    const actual = await collect([
      { type: "tool-input-start", id: "a", toolName: "lookup" },
      { type: "tool-input-start", id: "b", toolName: "missing" },
      { type: "tool-input-delta", id: "a", delta: "{\"q\":\"a\"}" },
      { type: "tool-input-delta", id: "b", delta: "{\"q\":\"b\"}" },
      { type: "tool-call", toolCallId: "b", toolName: "missing", input: { q: "b" } },
      { type: "tool-call", toolCallId: "a", toolName: "lookup", input: { q: "a" } },
      finish("tool-calls"),
    ], { tools: [lookup] });

    expect(actual.events).toEqual([
      { type: "tool-start", callId: "a", name: "lookup", title: "Knowledge lookup", kind: "search" },
      { type: "tool-start", callId: "b", name: "missing", title: "missing", kind: "other" },
      { type: "tool-input-delta", callId: "a", delta: "{\"q\":\"a\"}" },
      { type: "tool-input-delta", callId: "b", delta: "{\"q\":\"b\"}" },
      { type: "tool-input", callId: "b", input: { q: "b" } },
      { type: "tool-input", callId: "a", input: { q: "a" } },
    ]);
    expect(actual.result.toolCalls.map((call) => call.callId)).toEqual(["a", "b"]);
    expectValid(actual.events);
  });

  it("contains a mid-stream error and retains the partial message", async () => {
    const actual = await collect([
      { type: "text-start", id: "text-1" },
      { type: "text-delta", id: "text-1", text: "partial" },
      { type: "error", error: new Error("connection lost") },
    ]);

    expect(actual.events.at(-1)).toEqual({ type: "error", message: "connection lost", recoverable: false });
    expect(actual.result).toMatchObject({
      message: { role: "assistant", blocks: [{ type: "text", text: "partial" }] },
      stopReason: "error",
      error: { message: "connection lost", retryable: false },
    });
    expectValid(actual.events);
  });

  it("maps SDK custom parts onto the data-event escape hatch", async () => {
    const actual = await collect([
      { type: "custom", kind: "vendor.trace", providerMetadata: { primary: { phase: "decode" } } },
      finish(),
    ]);

    expect(actual.events).toEqual([{
      type: "data",
      name: "vendor.trace",
      data: { primary: { phase: "decode" } },
    }]);
    expectValid(actual.events);
  });

  it("contains an abort thrown after streaming starts", async () => {
    const controller = new AbortController();
    async function* aborted(): AsyncIterable<Part> {
      yield { type: "text-start", id: "text-1" };
      yield { type: "text-delta", id: "text-1", text: "partial" };
      controller.abort();
      throw new DOMException("cancelled", "AbortError");
    }
    const fixture = operations(aborted());
    const port = createSdkModelPortWithOperations({ endpoints }, fixture.sdk);
    const stream = port.streamTurn(request({ abort: controller.signal }));
    const events: RunEventData[] = [];
    for await (const event of stream) events.push(event);

    expect(events.at(-1)).toEqual({ type: "error", message: "cancelled", recoverable: false });
    expect(await stream.result).toMatchObject({ stopReason: "aborted", message: { blocks: [{ text: "partial" }] } });
    expectValid(events);
  });

  it("throws and rejects result when the SDK fails before its first part", async () => {
    const failure = new Error("unauthorized");
    const sdk: SdkOperations = {
      stream() { throw failure; },
      async generate() { throw failure; },
    };
    const port = createSdkModelPortWithOperations({ endpoints }, sdk);
    const stream = port.streamTurn(request());
    const resultRejection = expect(stream.result).rejects.toThrow("unauthorized");

    await expect(async () => {
      for await (const _event of stream) { /* no events */ }
    }).rejects.toThrow("unauthorized");
    await resultRejection;
  });
});

describe("routing, conversion, and controls", () => {
  it("selects a named endpoint and sends its URL and API key through fake fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(async () => new Response(JSON.stringify({
      id: "response-1",
      created: 1,
      model: "native-model",
      choices: [{ index: 0, message: { role: "assistant", content: "selected" }, finish_reason: "stop" }],
      usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
    }), { status: 200, headers: { "content-type": "application/json" } }));
    const port = createSdkModelPort({
      endpoints: {
        first: { protocol: "openai-compatible", baseUrl: "https://first.example/v1", apiKey: "first-key" },
        second: { protocol: "openai-compatible", baseUrl: "https://second.example/v1", apiKey: "second-key" },
      },
      fetch,
    });

    const result = await port.complete({
      model: { id: "native-model", provider: "second" },
      instructions: "Short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Hi" }] }],
      abort: new AbortController().signal,
    });

    expect(result.text).toBe("selected");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://second.example/v1/chat/completions");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer second-key");
  });

  it("throws for unknown or ambiguous endpoint selection", () => {
    const fixture = operations([]);
    const port = createSdkModelPortWithOperations({
      endpoints: {
        one: endpoints.primary,
        two: { ...endpoints.primary, baseUrl: "https://two.example/v1" },
      },
    }, fixture.sdk);

    expect(() => port.streamTurn(request({ model: { id: "m", provider: "missing" } }))).toThrow("Unknown model endpoint");
    expect(() => port.streamTurn(request({ model: { id: "m" } }))).toThrow("multiple endpoints");
  });

  it("round-trips opaque assistant metadata into SDK provider options", () => {
    const messageMeta = { primary: { responseId: "response-1" } };
    const reasoningMeta = { primary: { signature: "sig-1" } };
    const toolMeta = { primary: { itemId: "item-1" } };
    const converted = toModelMessages("System", [{
      role: "assistant",
      providerMeta: messageMeta,
      blocks: [
        { type: "thinking", text: "thought", providerMeta: reasoningMeta },
        { type: "toolCall", callId: "call-1", name: "lookup", input: { q: "x" }, providerMeta: toolMeta },
      ],
    }]);

    expect(converted[1]).toEqual({
      role: "assistant",
      providerOptions: messageMeta,
      content: [
        { type: "reasoning", text: "thought", providerOptions: reasoningMeta },
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { q: "x" }, providerOptions: toolMeta },
      ],
    });
  });

  it("sends thinking options only for explicitly mapped model levels", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations({
      endpoints,
      thinkingLevelMap: { "reasoning-*": { supportedLevels: ["low", "high"] } },
    }, mapped.sdk);
    const first = port.streamTurn(request({ thinking: "high" }));
    for await (const _event of first) { /* drain */ }
    await first.result;
    const second = port.streamTurn(request({ model: { id: "plain-model" }, thinking: "high" }));
    for await (const _event of second) { /* drain */ }
    await second.result;

    expect(mapped.calls[0]?.providerOptions).toEqual({ primary: { reasoningEffort: "high" } });
    expect(mapped.calls[1]?.providerOptions).toBeUndefined();
  });

  it("uses generateText semantics for complete()", async () => {
    const fixture = operations([]);
    const port = createSdkModelPortWithOperations({ endpoints }, fixture.sdk);
    const result = await port.complete({
      model: { id: "short-model" },
      instructions: "Be short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Title?" }] }],
      budget: { maxOutputTokens: 20 },
      abort: new AbortController().signal,
    });

    expect(result).toEqual({ text: "short answer", usage });
    expect(fixture.calls[0]?.maxOutputTokens).toBe(20);
  });
});
