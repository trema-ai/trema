import { generateKeyPairSync } from "node:crypto";

import type { RunEventData, ToolDef, TurnRequest, Usage } from "@trema/harness";
import { RunEventDataSchema } from "@trema/harness";
import type { LanguageModelUsage, TextStreamPart, ToolSet } from "ai";
import { describe, expect, it, vi } from "vitest";

import type { ModelEndpoints } from "#models/index.js";
import { createSdkModelPort } from "#models/index.js";
import { createSdkModelPortWithOperations } from "#models/sdk-model-port.js";
import type { SdkCallOptions, SdkOperations } from "#models/sdk-operations.js";
import { toModelMessages } from "#models/to-model-messages.js";

type Part = TextStreamPart<ToolSet>;

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

const anthropicEndpoints = {
  claude: {
    protocol: "anthropic" as const,
    baseUrl: "https://anthropic.example.test/v1",
    apiKey: "claude-secret",
  },
};

const googleEndpoints = {
  gemini: {
    protocol: "google" as const,
    baseUrl: "https://gemini.example.test/v1beta",
    apiKey: "gemini-secret",
  },
};

const responsesEndpoints = {
  azure: {
    protocol: "openai-responses" as const,
    baseUrl: "https://contoso.openai.azure.test/openai/v1",
    apiKey: "azure-secret",
  },
};

const bedrockEndpoints = {
  aws: {
    protocol: "bedrock" as const,
    baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.test",
    region: "eu-west-1",
    accessKeyId: "AKIAEXAMPLEKEYID",
    secretAccessKey: "bedrock-secret",
  },
};

/**
 * A throwaway key pair, generated here rather than checked in: the wire test
 * below needs a signature the auth library will actually produce, and a private
 * key in the repository is a private key in the repository whatever it opens.
 */
const serviceAccountKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

const vertexEndpoints = {
  vertex: {
    protocol: "vertex" as const,
    baseUrl: "https://us-central1-aiplatform.example.test/v1beta1",
    project: "trema-test",
    location: "us-central1",
    serviceAccount: {
      clientEmail: "trema@trema-test.iam.gserviceaccount.example",
      privateKey: serviceAccountKey,
    },
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
          fullStream:
            Symbol.asyncIterator in parts
              ? parts
              : (async function* () {
                  yield* parts;
                })(),
        };
      },
      async generate(options) {
        calls.push(options);
        return { text: "short answer", usage: sdkUsage };
      },
    },
  };
}

async function collect(
  parts: readonly Part[],
  overrides: Partial<TurnRequest> = {},
  named: ModelEndpoints = endpoints,
) {
  const fixture = operations(parts);
  const port = createSdkModelPortWithOperations({ endpoints: named }, fixture.sdk);
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
      "reasoning-start",
      "reasoning-delta",
      "reasoning-end",
      "text-start",
      "text-delta",
      "text-end",
    ]);
    expect(actual.result.message.blocks).toEqual([
      { type: "thinking", text: "Consider", providerMeta: signature },
      { type: "text", text: "Answer" },
    ]);
    expectValid(actual.events);
  });

  it("keeps an Anthropic reasoning signature on the block it closes", async () => {
    // What an Anthropic turn streams: thinking deltas, then the signature that
    // authenticates them, then the answer. The signature is what a later turn
    // must send back, so the test that matters is that it reaches the block.
    const signature = { anthropic: { signature: "c2lnbmF0dXJl" } };
    const actual = await collect(
      [
        { type: "reasoning-start", id: "thinking-1" },
        { type: "reasoning-delta", id: "thinking-1", text: "Check the ledger" },
        { type: "reasoning-delta", id: "thinking-1", text: " twice" },
        { type: "reasoning-end", id: "thinking-1", providerMetadata: signature },
        { type: "text-start", id: "msg-1" },
        { type: "text-delta", id: "msg-1", text: "It balances." },
        { type: "text-end", id: "msg-1" },
        finish(),
      ],
      { model: { id: "claude-thinking", provider: "claude" } },
      anthropicEndpoints,
    );

    expect(actual.events).toEqual([
      { type: "reasoning-start", blockId: "thinking-1" },
      { type: "reasoning-delta", blockId: "thinking-1", delta: "Check the ledger" },
      { type: "reasoning-delta", blockId: "thinking-1", delta: " twice" },
      { type: "reasoning-end", blockId: "thinking-1" },
      { type: "text-start", blockId: "msg-1" },
      { type: "text-delta", blockId: "msg-1", delta: "It balances." },
      { type: "text-end", blockId: "msg-1" },
    ]);
    expect(actual.result.message.blocks).toEqual([
      { type: "thinking", text: "Check the ledger twice", providerMeta: signature },
      { type: "text", text: "It balances." },
    ]);
    expect(actual.result.stopReason).toBe("stop");
    expectValid(actual.events);
  });

  it("keeps a Gemini thought signature that arrives before the block closes", async () => {
    // What a Gemini turn streams: thought parts the provider turns into
    // reasoning, each carrying the signature of the thought it belongs to, and
    // a closing part that carries none. The signature is what a later turn must
    // send back, so this proves the mapping takes it from where Gemini puts it
    // rather than from the closing part Anthropic uses.
    const signature = { google: { thoughtSignature: "CtoBAVSoXO1" } };
    const actual = await collect(
      [
        { type: "reasoning-start", id: "0" },
        { type: "reasoning-delta", id: "0", text: "Weigh the options" },
        { type: "reasoning-delta", id: "0", text: " once more", providerMetadata: signature },
        { type: "reasoning-end", id: "0" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", text: "The second one." },
        { type: "text-end", id: "1" },
        finish(),
      ],
      { model: { id: "gemini-thinking", provider: "gemini" } },
      googleEndpoints,
    );

    expect(actual.events).toEqual([
      { type: "reasoning-start", blockId: "0" },
      { type: "reasoning-delta", blockId: "0", delta: "Weigh the options" },
      { type: "reasoning-delta", blockId: "0", delta: " once more" },
      { type: "reasoning-end", blockId: "0" },
      { type: "text-start", blockId: "1" },
      { type: "text-delta", blockId: "1", delta: "The second one." },
      { type: "text-end", blockId: "1" },
    ]);
    expect(actual.result.message.blocks).toEqual([
      { type: "thinking", text: "Weigh the options once more", providerMeta: signature },
      { type: "text", text: "The second one." },
    ]);
    expect(actual.result.stopReason).toBe("stop");
    expectValid(actual.events);
  });

  it("keeps every Responses summary part its own block under one reasoning item", async () => {
    // What a Responses turn streams: one reasoning item split into numbered
    // summary parts, each arriving as its own block whose id is the item id and
    // the summary index joined, and every part carrying the item id back in its
    // metadata. The answer follows, tagged with the item id of its own message.
    // Two parts are what makes this protocol's shape visible: a single block
    // would have proved nothing the other protocols do not already prove.
    const opened = { openai: { itemId: "rs_1", reasoningEncryptedContent: null } };
    const closed = { openai: { itemId: "rs_1" } };
    const actual = await collect(
      [
        { type: "reasoning-start", id: "rs_1:0", providerMetadata: opened },
        { type: "reasoning-delta", id: "rs_1:0", text: "Read the deployment name" },
        { type: "reasoning-end", id: "rs_1:0", providerMetadata: closed },
        { type: "reasoning-start", id: "rs_1:1", providerMetadata: opened },
        { type: "reasoning-delta", id: "rs_1:1", text: "Then answer" },
        { type: "reasoning-end", id: "rs_1:1", providerMetadata: closed },
        { type: "text-start", id: "msg_1", providerMetadata: { openai: { itemId: "msg_1" } } },
        { type: "text-delta", id: "msg_1", text: "Deployed and answering." },
        { type: "text-end", id: "msg_1", providerMetadata: { openai: { itemId: "msg_1" } } },
        finish(),
      ],
      { model: { id: "gpt-5-reasoning", provider: "azure" } },
      responsesEndpoints,
    );

    expect(actual.events).toEqual([
      { type: "reasoning-start", blockId: "rs_1:0" },
      { type: "reasoning-delta", blockId: "rs_1:0", delta: "Read the deployment name" },
      { type: "reasoning-end", blockId: "rs_1:0" },
      { type: "reasoning-start", blockId: "rs_1:1" },
      { type: "reasoning-delta", blockId: "rs_1:1", delta: "Then answer" },
      { type: "reasoning-end", blockId: "rs_1:1" },
      { type: "text-start", blockId: "msg_1" },
      { type: "text-delta", blockId: "msg_1", delta: "Deployed and answering." },
      { type: "text-end", blockId: "msg_1" },
    ]);
    // Two thinking blocks, not one: the summary parts are separate blocks that
    // name the same item, which is how a later turn reassembles them.
    expect(actual.result.message.blocks).toEqual([
      {
        type: "thinking",
        text: "Read the deployment name",
        providerMeta: { openai: { itemId: "rs_1" } },
      },
      { type: "thinking", text: "Then answer", providerMeta: { openai: { itemId: "rs_1" } } },
      {
        type: "text",
        text: "Deployed and answering.",
        providerMeta: { openai: { itemId: "msg_1" } },
      },
    ]);
    expect(actual.result.stopReason).toBe("stop");
    expectValid(actual.events);
  });

  it("keeps a Bedrock reasoning signature that arrives as a delta of its own", async () => {
    // What a Bedrock turn streams: a converse-stream reasoning block whose
    // text arrives as deltas, and whose signature arrives as one more delta
    // carrying no text at all — the provider has nowhere else to put it,
    // because the block-stop event this protocol sends carries no metadata.
    // The signature is what a later turn must send back, so this proves the
    // mapping takes it from a delta that adds nothing to the text.
    const signature = {
      amazonBedrock: { signature: "EqoBCkgIB" },
      bedrock: { signature: "EqoBCkgIB" },
    };
    const actual = await collect(
      [
        { type: "reasoning-start", id: "0" },
        { type: "reasoning-delta", id: "0", text: "Price the request" },
        { type: "reasoning-delta", id: "0", text: " in this region" },
        { type: "reasoning-delta", id: "0", text: "", providerMetadata: signature },
        { type: "reasoning-end", id: "0" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", text: "Signed and answered." },
        { type: "text-end", id: "1" },
        finish(),
      ],
      { model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", provider: "aws" } },
      bedrockEndpoints,
    );

    // The signature delta is an event like any other, empty text and all: the
    // run view records what the provider sent rather than a tidied version.
    expect(actual.events).toEqual([
      { type: "reasoning-start", blockId: "0" },
      { type: "reasoning-delta", blockId: "0", delta: "Price the request" },
      { type: "reasoning-delta", blockId: "0", delta: " in this region" },
      { type: "reasoning-delta", blockId: "0", delta: "" },
      { type: "reasoning-end", blockId: "0" },
      { type: "text-start", blockId: "1" },
      { type: "text-delta", blockId: "1", delta: "Signed and answered." },
      { type: "text-end", blockId: "1" },
    ]);
    expect(actual.result.message.blocks).toEqual([
      { type: "thinking", text: "Price the request in this region", providerMeta: signature },
      { type: "text", text: "Signed and answered." },
    ]);
    expect(actual.result.stopReason).toBe("stop");
    expectValid(actual.events);
  });

  it("keeps a Vertex thought signature that arrives under both of its keys", async () => {
    // What a Gemini-on-Vertex turn streams: the Gemini shape, thought parts and
    // all, with one difference the mapping has to survive. The provider stamps
    // its metadata under every name it answers to, and on Vertex that is two —
    // `googleVertex` and `vertex` — where the Gemini API stamps only `google`.
    // The signature is what a later turn must send back, so what matters is
    // that both keys reach the block whole rather than one of them winning.
    const signature = {
      googleVertex: { thoughtSignature: "CtoBAVSoXO1" },
      vertex: { thoughtSignature: "CtoBAVSoXO1" },
    };
    const actual = await collect(
      [
        { type: "reasoning-start", id: "0" },
        { type: "reasoning-delta", id: "0", text: "Check the project's quota" },
        { type: "reasoning-delta", id: "0", text: " first", providerMetadata: signature },
        { type: "reasoning-end", id: "0" },
        { type: "text-start", id: "1" },
        { type: "text-delta", id: "1", text: "There is room." },
        { type: "text-end", id: "1" },
        finish(),
      ],
      { model: { id: "gemini-2.5-flash", provider: "vertex" } },
      vertexEndpoints,
    );

    expect(actual.events).toEqual([
      { type: "reasoning-start", blockId: "0" },
      { type: "reasoning-delta", blockId: "0", delta: "Check the project's quota" },
      { type: "reasoning-delta", blockId: "0", delta: " first" },
      { type: "reasoning-end", blockId: "0" },
      { type: "text-start", blockId: "1" },
      { type: "text-delta", blockId: "1", delta: "There is room." },
      { type: "text-end", blockId: "1" },
    ]);
    expect(actual.result.message.blocks).toEqual([
      { type: "thinking", text: "Check the project's quota first", providerMeta: signature },
      { type: "text", text: "There is room." },
    ]);
    expect(actual.result.stopReason).toBe("stop");
    expectValid(actual.events);
  });

  it("maps a validated tool call using the request registry", async () => {
    const actual = await collect(
      [
        { type: "tool-input-start", id: "call-1", toolName: "lookup" },
        { type: "tool-input-delta", id: "call-1", delta: '{"q":' },
        { type: "tool-input-delta", id: "call-1", delta: '"trema"}' },
        { type: "tool-call", toolCallId: "call-1", toolName: "lookup", input: { q: "trema" } },
        finish("tool-calls"),
      ],
      { tools: [lookup] },
    );

    expect(actual.events).toEqual([
      {
        type: "tool-start",
        callId: "call-1",
        name: "lookup",
        title: "Knowledge lookup",
        kind: "search",
      },
      { type: "tool-input-delta", callId: "call-1", delta: '{"q":' },
      { type: "tool-input-delta", callId: "call-1", delta: '"trema"}' },
      { type: "tool-input", callId: "call-1", input: { q: "trema" } },
    ]);
    expect(actual.result.stopReason).toBe("toolUse");
    expect(actual.result.toolCalls).toEqual([
      { callId: "call-1", name: "lookup", input: { q: "trema" } },
    ]);
    expectValid(actual.events);
  });

  it("keeps parallel tool streams distinct and interleaved", async () => {
    const actual = await collect(
      [
        { type: "tool-input-start", id: "a", toolName: "lookup" },
        { type: "tool-input-start", id: "b", toolName: "missing" },
        { type: "tool-input-delta", id: "a", delta: '{"q":"a"}' },
        { type: "tool-input-delta", id: "b", delta: '{"q":"b"}' },
        { type: "tool-call", toolCallId: "b", toolName: "missing", input: { q: "b" } },
        { type: "tool-call", toolCallId: "a", toolName: "lookup", input: { q: "a" } },
        finish("tool-calls"),
      ],
      { tools: [lookup] },
    );

    expect(actual.events).toEqual([
      {
        type: "tool-start",
        callId: "a",
        name: "lookup",
        title: "Knowledge lookup",
        kind: "search",
      },
      { type: "tool-start", callId: "b", name: "missing", title: "missing", kind: "other" },
      { type: "tool-input-delta", callId: "a", delta: '{"q":"a"}' },
      { type: "tool-input-delta", callId: "b", delta: '{"q":"b"}' },
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

    expect(actual.events.at(-1)).toEqual({
      type: "error",
      message: "connection lost",
      recoverable: false,
    });
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

    expect(actual.events).toEqual([
      {
        type: "data",
        name: "vendor.trace",
        data: { primary: { phase: "decode" } },
      },
    ]);
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
    expect(await stream.result).toMatchObject({
      stopReason: "aborted",
      message: { blocks: [{ text: "partial" }] },
    });
    expectValid(events);
  });

  it("throws and rejects result when the SDK fails before its first part", async () => {
    const failure = new Error("unauthorized");
    const sdk: SdkOperations = {
      stream() {
        throw failure;
      },
      async generate() {
        throw failure;
      },
    };
    const port = createSdkModelPortWithOperations({ endpoints }, sdk);
    const stream = port.streamTurn(request());
    const resultRejection = expect(stream.result).rejects.toThrow("unauthorized");

    await expect(async () => {
      for await (const _event of stream) {
        /* no events */
      }
    }).rejects.toThrow("unauthorized");
    await resultRejection;
  });
});

describe("routing, conversion, and controls", () => {
  it("selects a named endpoint and sends its URL and API key through fake fetch", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: "response-1",
            created: 1,
            model: "native-model",
            choices: [
              {
                index: 0,
                message: { role: "assistant", content: "selected" },
                finish_reason: "stop",
              },
            ],
            usage: { prompt_tokens: 2, completion_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const port = createSdkModelPort({
      endpoints: {
        first: {
          protocol: "openai-compatible",
          baseUrl: "https://first.example/v1",
          apiKey: "first-key",
        },
        second: {
          protocol: "openai-compatible",
          baseUrl: "https://second.example/v1",
          apiKey: "second-key",
        },
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

  it("sends an anthropic endpoint's credential as x-api-key, not a bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            type: "message",
            id: "msg-1",
            model: "claude-model",
            content: [{ type: "text", text: "answered" }],
            stop_reason: "end_turn",
            usage: { input_tokens: 2, output_tokens: 1 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const port = createSdkModelPort({ endpoints: anthropicEndpoints, fetch });

    const result = await port.complete({
      model: { id: "claude-model", provider: "claude" },
      instructions: "Short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Hi" }] }],
      abort: new AbortController().signal,
    });

    expect(result.text).toBe("answered");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    expect(String(url)).toBe("https://anthropic.example.test/v1/messages");
    const headers = new Headers(init?.headers);
    expect(headers.get("x-api-key")).toBe("claude-secret");
    expect(headers.get("authorization")).toBeNull();
    expect(headers.get("anthropic-version")).toBe("2023-06-01");
  });

  it("sends a google endpoint's credential as x-goog-api-key, not a bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: { parts: [{ text: "answered" }], role: "model" },
                finishReason: "STOP",
              },
            ],
            usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const port = createSdkModelPort({ endpoints: googleEndpoints, fetch });

    const result = await port.complete({
      model: { id: "gemini-model", provider: "gemini" },
      instructions: "Short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Hi" }] }],
      abort: new AbortController().signal,
    });

    expect(result.text).toBe("answered");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    // The model id is part of the path on this protocol, and the stored base
    // URL is what it hangs off — no vendor address is reached for.
    expect(String(url)).toBe(
      "https://gemini.example.test/v1beta/models/gemini-model:generateContent",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("x-goog-api-key")).toBe("gemini-secret");
    expect(headers.get("authorization")).toBeNull();
  });

  it("posts an openai-responses endpoint's turn to the Responses path with a bearer token", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            id: "resp_1",
            created_at: 1_700_000_000,
            model: "gpt-5-deployment",
            status: "completed",
            output: [
              {
                type: "message",
                role: "assistant",
                id: "msg_1",
                content: [{ type: "output_text", text: "answered", annotations: [] }],
              },
            ],
            usage: { input_tokens: 2, output_tokens: 1, total_tokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const port = createSdkModelPort({ endpoints: responsesEndpoints, fetch });

    const result = await port.complete({
      model: { id: "gpt-5-deployment", provider: "azure" },
      instructions: "Short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Hi" }] }],
      abort: new AbortController().signal,
    });

    expect(result.text).toBe("answered");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    // The Responses path, not the chat-completions one the OpenAI-compatible
    // protocol reaches: this is the whole reason the member exists.
    expect(String(url)).toBe("https://contoso.openai.azure.test/openai/v1/responses");
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer azure-secret");
    // The model id goes in the body, which on Azure is the deployment name.
    expect(JSON.parse(String(init?.body))).toMatchObject({ model: "gpt-5-deployment" });
  });

  it("signs a bedrock endpoint's turn for the region the endpoint states", async () => {
    const fetch = vi.fn<typeof globalThis.fetch>(
      async () =>
        new Response(
          JSON.stringify({
            output: {
              message: { role: "assistant", content: [{ text: "answered" }] },
            },
            stopReason: "end_turn",
            usage: { inputTokens: 2, outputTokens: 1, totalTokens: 3 },
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        ),
    );
    const port = createSdkModelPort({ endpoints: bedrockEndpoints, fetch });

    const result = await port.complete({
      model: { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", provider: "aws" },
      instructions: "Short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Hi" }] }],
      abort: new AbortController().signal,
    });

    expect(result.text).toBe("answered");
    expect(fetch).toHaveBeenCalledOnce();
    const [url, init] = fetch.mock.calls[0] ?? [];
    // The model id is part of the path on this protocol, escaped because a
    // Bedrock id carries a colon, and the converse call is what a turn is.
    expect(String(url)).toBe(
      "https://bedrock-runtime.eu-west-1.amazonaws.test/model/anthropic.claude-sonnet-4-5-20250929-v1%3A0/converse",
    );
    const headers = new Headers(init?.headers);
    const authorization = headers.get("authorization") ?? "";
    // No bearer token and no key header: this protocol authenticates by
    // signing the request, and the signature names the region the endpoint
    // states rather than anything read off the host.
    expect(authorization).toContain("AWS4-HMAC-SHA256");
    expect(authorization).toContain("Credential=AKIAEXAMPLEKEYID/");
    expect(authorization).toMatch(/\/eu-west-1\/bedrock\/aws4_request/);
    expect(headers.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
    // The secret is spent on the signature and never travels itself.
    expect(JSON.stringify([...headers])).not.toContain("bedrock-secret");
  });

  it("mints a vertex endpoint's token from its service account and sends it as a bearer", async () => {
    // Two calls and no network in either. The credential exchange is faked at
    // the same seam the model call is, because the resolver hands the injected
    // fetch to the auth library as well: one function is where this package
    // reaches the network, and a token exchange outside it would be the single
    // call a deployment could neither see nor route.
    const fetch = vi.fn<typeof globalThis.fetch>(async (url) => {
      if (String(url) === "https://oauth2.googleapis.com/token") {
        return new Response(
          JSON.stringify({
            access_token: "ya29.minted-token",
            token_type: "Bearer",
            expires_in: 3600,
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      }
      return new Response(
        JSON.stringify({
          candidates: [
            { content: { parts: [{ text: "answered" }], role: "model" }, finishReason: "STOP" },
          ],
          usageMetadata: { promptTokenCount: 2, candidatesTokenCount: 1, totalTokenCount: 3 },
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
    const port = createSdkModelPort({ endpoints: vertexEndpoints, fetch });

    const result = await port.complete({
      model: { id: "gemini-2.5-flash", provider: "vertex" },
      instructions: "Short.",
      messages: [{ role: "user", blocks: [{ type: "text", text: "Hi" }] }],
      abort: new AbortController().signal,
    });

    expect(result.text).toBe("answered");
    expect(fetch).toHaveBeenCalledTimes(2);

    // The exchange the stored service account pays for: a JWT bearer grant,
    // signed by the stored key and issued in the stored account's name.
    const [tokenUrl, tokenInit] = fetch.mock.calls[0] ?? [];
    expect(String(tokenUrl)).toBe("https://oauth2.googleapis.com/token");
    expect(tokenInit?.method).toBe("POST");
    const grant = new URLSearchParams(String(tokenInit?.body));
    expect(grant.get("grant_type")).toBe("urn:ietf:params:oauth:grant-type:jwt-bearer");
    const claims = JSON.parse(
      Buffer.from(String(grant.get("assertion")).split(".")[1] ?? "", "base64url").toString(),
    );
    expect(claims).toMatchObject({
      iss: "trema@trema-test.iam.gserviceaccount.example",
      scope: "https://www.googleapis.com/auth/cloud-platform",
      aud: "https://oauth2.googleapis.com/token",
    });

    const [url, init] = fetch.mock.calls[1] ?? [];
    // Host and version come from the stored base URL; the project and the
    // location are their own fields, and the resource path is composed from
    // all three rather than read out of one of them.
    expect(String(url)).toBe(
      "https://us-central1-aiplatform.example.test/v1beta1/projects/trema-test/locations/us-central1/publishers/google/models/gemini-2.5-flash:generateContent",
    );
    const headers = new Headers(init?.headers);
    expect(headers.get("authorization")).toBe("Bearer ya29.minted-token");
    // The key signs the grant and never travels itself, on either call.
    expect(JSON.stringify(fetch.mock.calls)).not.toContain("BEGIN PRIVATE KEY");
  });

  it("throws for unknown or ambiguous endpoint selection", () => {
    const fixture = operations([]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints: {
          one: endpoints.primary,
          two: { ...endpoints.primary, baseUrl: "https://two.example/v1" },
        },
      },
      fixture.sdk,
    );

    expect(() => port.streamTurn(request({ model: { id: "m", provider: "missing" } }))).toThrow(
      "Unknown model endpoint",
    );
    expect(() => port.streamTurn(request({ model: { id: "m" } }))).toThrow("multiple endpoints");
  });

  it("round-trips opaque assistant metadata into SDK provider options", () => {
    const messageMeta = { primary: { responseId: "response-1" } };
    const reasoningMeta = { primary: { signature: "sig-1" } };
    const toolMeta = { primary: { itemId: "item-1" } };
    const converted = toModelMessages("System", [
      {
        role: "assistant",
        providerMeta: messageMeta,
        blocks: [
          { type: "thinking", text: "thought", providerMeta: reasoningMeta },
          {
            type: "toolCall",
            callId: "call-1",
            name: "lookup",
            input: { q: "x" },
            providerMeta: toolMeta,
          },
        ],
      },
    ]);

    expect(converted[1]).toEqual({
      role: "assistant",
      providerOptions: messageMeta,
      content: [
        { type: "reasoning", text: "thought", providerOptions: reasoningMeta },
        {
          type: "tool-call",
          toolCallId: "call-1",
          toolName: "lookup",
          input: { q: "x" },
          providerOptions: toolMeta,
        },
      ],
    });
  });

  it("maps an ok tool result with images to content output", () => {
    const converted = toModelMessages("System", [
      {
        role: "assistant",
        blocks: [{ type: "toolCall", callId: "call-1", name: "lookup", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        status: "ok",
        blocks: [
          { type: "text", text: "chart" },
          { type: "image", data: "base64-data", mediaType: "image/png" },
        ],
      },
    ]);

    expect(converted[2]).toEqual({
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "lookup",
          output: {
            type: "content",
            value: [
              { type: "text", text: "chart" },
              {
                type: "file",
                data: { type: "data", data: "base64-data" },
                mediaType: "image/png",
              },
            ],
          },
        },
      ],
    });
  });

  it("maps an error tool result to error text", () => {
    const converted = toModelMessages("System", [
      {
        role: "assistant",
        blocks: [{ type: "toolCall", callId: "call-1", name: "lookup", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        status: "error",
        blocks: [{ type: "text", text: "lookup failed" }],
      },
    ]);

    expect(converted[2]).toMatchObject({
      role: "tool",
      content: [{ output: { type: "error-text", value: "lookup failed" } }],
    });
  });

  it("maps a denied tool result to execution denied with its reason", () => {
    const converted = toModelMessages("System", [
      {
        role: "assistant",
        blocks: [{ type: "toolCall", callId: "call-1", name: "lookup", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        status: "denied",
        blocks: [{ type: "text", text: "denied by policy" }],
      },
    ]);

    expect(converted[2]).toMatchObject({
      role: "tool",
      content: [{ output: { type: "execution-denied", reason: "denied by policy" } }],
    });

    const withoutReason = toModelMessages("System", [
      {
        role: "assistant",
        blocks: [{ type: "toolCall", callId: "call-2", name: "lookup", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-2",
        status: "denied",
        blocks: [],
      },
    ]);
    expect(withoutReason[2]).toMatchObject({
      content: [{ output: { type: "execution-denied" } }],
    });
    expect(
      (withoutReason[2] as { content: Array<{ output: unknown }> }).content[0]?.output,
    ).not.toHaveProperty("reason");
  });

  it("forwards only genuine message-level metadata on tool results", () => {
    const providerMeta = { primary: { responseId: "response-1" } };
    const converted = toModelMessages("System", [
      {
        role: "assistant",
        blocks: [{ type: "toolCall", callId: "call-1", name: "lookup", input: {} }],
      },
      {
        role: "toolResult",
        toolCallId: "call-1",
        status: "ok",
        providerMeta,
        blocks: [{ type: "text", text: "full output", providerMeta: { ignored: true } }],
      },
    ]);

    expect(converted[2]).toEqual({
      role: "tool",
      providerOptions: providerMeta,
      content: [
        {
          type: "tool-result",
          toolCallId: "call-1",
          toolName: "lookup",
          output: { type: "text", value: "full output" },
        },
      ],
    });
  });

  it("rejects thinking and tool-call blocks in tool results", () => {
    const assistant = {
      role: "assistant" as const,
      blocks: [{ type: "toolCall" as const, callId: "call-1", name: "lookup", input: {} }],
    };

    expect(() =>
      toModelMessages("System", [
        assistant,
        {
          role: "toolResult",
          toolCallId: "call-1",
          blocks: [{ type: "thinking", text: "invalid" }],
        },
      ]),
    ).toThrow("Invalid thinking block in toolResult message");
    expect(() =>
      toModelMessages("System", [
        assistant,
        {
          role: "toolResult",
          toolCallId: "call-1",
          blocks: [{ type: "toolCall", callId: "nested", name: "lookup", input: {} }],
        },
      ]),
    ).toThrow("Invalid toolCall block in toolResult message");
  });

  it("sends thinking options only for explicitly mapped model levels", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints,
        thinkingLevelMap: { "reasoning-*": { supportedLevels: ["low", "high"] } },
      },
      mapped.sdk,
    );
    const first = port.streamTurn(request({ thinking: "high" }));
    for await (const _event of first) {
      /* drain */
    }
    await first.result;
    const second = port.streamTurn(request({ model: { id: "plain-model" }, thinking: "high" }));
    for await (const _event of second) {
      /* drain */
    }
    await second.result;

    expect(mapped.calls[0]?.providerOptions).toEqual({ primary: { reasoningEffort: "high" } });
    expect(mapped.calls[1]?.providerOptions).toBeUndefined();
  });

  it("sends an anthropic thinking budget under the provider's own options key", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints: anthropicEndpoints,
        thinkingLevelMap: { "claude-*": { supportedLevels: ["medium"] } },
      },
      mapped.sdk,
    );
    const model = { id: "claude-thinking", provider: "claude" };
    const first = port.streamTurn(request({ model, thinking: "medium" }));
    for await (const _event of first) {
      /* drain */
    }
    await first.result;
    // A level the model is not mapped for is refused the same way an unmapped
    // model is: no options at all, never a smaller budget.
    const second = port.streamTurn(request({ model, thinking: "high" }));
    for await (const _event of second) {
      /* drain */
    }
    await second.result;

    expect(mapped.calls[0]?.providerOptions).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 16_384 } },
    });
    expect(mapped.calls[1]?.providerOptions).toBeUndefined();
  });

  it("sends a google thinking budget and asks for the thoughts back", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints: googleEndpoints,
        thinkingLevelMap: { "gemini-*": { supportedLevels: ["low"] } },
      },
      mapped.sdk,
    );
    const model = { id: "gemini-thinking", provider: "gemini" };
    const first = port.streamTurn(request({ model, thinking: "low" }));
    for await (const _event of first) {
      /* drain */
    }
    await first.result;
    // A level the model is not mapped for is refused the same way an unmapped
    // model is: no options at all, never a smaller budget.
    const second = port.streamTurn(request({ model, thinking: "high" }));
    for await (const _event of second) {
      /* drain */
    }
    await second.result;

    expect(mapped.calls[0]?.providerOptions).toEqual({
      google: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
    });
    expect(mapped.calls[1]?.providerOptions).toBeUndefined();
  });

  it("sends an openai-responses effort under the provider's own options key", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints: responsesEndpoints,
        thinkingLevelMap: { "gpt-5-*": { supportedLevels: ["high"] } },
      },
      mapped.sdk,
    );
    const model = { id: "gpt-5-reasoning", provider: "azure" };
    const first = port.streamTurn(request({ model, thinking: "high" }));
    for await (const _event of first) {
      /* drain */
    }
    await first.result;
    // A level the model is not mapped for is refused the same way an unmapped
    // model is: no options at all, never a lesser effort.
    const second = port.streamTurn(request({ model, thinking: "low" }));
    for await (const _event of second) {
      /* drain */
    }
    await second.result;

    // The key is `openai` and not `azure`, the endpoint's name — the provider
    // reads it under its own name whatever a deployment calls the row.
    expect(mapped.calls[0]?.providerOptions).toEqual({ openai: { reasoningEffort: "high" } });
    expect(mapped.calls[1]?.providerOptions).toBeUndefined();
  });

  it("sends a bedrock thinking budget under this protocol's own option name", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints: bedrockEndpoints,
        thinkingLevelMap: { "anthropic.claude-*": { supportedLevels: ["medium"] } },
      },
      mapped.sdk,
    );
    const model = { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", provider: "aws" };
    const first = port.streamTurn(request({ model, thinking: "medium" }));
    for await (const _event of first) {
      /* drain */
    }
    await first.result;
    // A level the model is not mapped for is refused the same way an unmapped
    // model is: no options at all, never a smaller budget.
    const second = port.streamTurn(request({ model, thinking: "high" }));
    for await (const _event of second) {
      /* drain */
    }
    await second.result;

    // The budget is the Anthropic table's, which is the point of sharing it:
    // the same models, reached through another front door, think the same.
    expect(mapped.calls[0]?.providerOptions).toEqual({
      bedrock: { reasoningConfig: { type: "enabled", budgetTokens: 16_384 } },
    });
    expect(mapped.calls[1]?.providerOptions).toBeUndefined();
  });

  it("sends a vertex thinking budget under the key the Gemini models read there", async () => {
    const mapped = operations([finish()]);
    const port = createSdkModelPortWithOperations(
      {
        endpoints: vertexEndpoints,
        thinkingLevelMap: { "gemini-*": { supportedLevels: ["low"] } },
      },
      mapped.sdk,
    );
    const model = { id: "gemini-2.5-flash", provider: "vertex" };
    const first = port.streamTurn(request({ model, thinking: "low" }));
    for await (const _event of first) {
      /* drain */
    }
    await first.result;
    // A level the model is not mapped for is refused the same way an unmapped
    // model is: no options at all, never a smaller budget.
    const second = port.streamTurn(request({ model, thinking: "high" }));
    for await (const _event of second) {
      /* drain */
    }
    await second.result;

    // The key is `googleVertex`, not `google` and not the endpoint's name: a
    // Gemini model reached through Vertex reads the first of the two names its
    // provider answers to. The budget is the Google table's, because it is the
    // same model on the other side of both.
    expect(mapped.calls[0]?.providerOptions).toEqual({
      googleVertex: { thinkingConfig: { thinkingBudget: 2048, includeThoughts: true } },
    });
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
