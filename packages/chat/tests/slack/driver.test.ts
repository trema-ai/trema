import { describe, expect, it, vi } from "vitest";
import { SurfaceDriverError, type SurfaceRef } from "#chat/index.js";
import { SlackDriver, type SlackDriverOptions } from "#chat/slack/index.js";

const surface = {
  surface: "slack",
  locationRef: "T1:C1",
  channelRef: "C1",
  threadRef: "1800000000.000001",
  teamRef: "T1",
  recipient: { teamRef: "T1", userRef: "U1" },
} as const satisfies SurfaceRef;

interface CapturedCall {
  body: string;
  contentType: string | null;
  method: string;
}

function fakeSlack(
  responses: readonly {
    body: Record<string, unknown>;
    status?: number;
    headers?: Headers | Record<string, string>;
  }[],
): { calls: CapturedCall[]; fetch: typeof fetch } {
  const calls: CapturedCall[] = [];
  let index = 0;
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push({
      body: String(init?.body ?? ""),
      contentType: new Headers(init?.headers).get("content-type"),
      method: url.pathname.split("/").at(-1) ?? "",
    });
    const response = responses[index];
    index += 1;
    if (response === undefined) throw new Error("No fake Slack response remains");
    return Response.json(response.body, {
      status: response.status ?? 200,
      ...(response.headers === undefined ? {} : { headers: response.headers }),
    });
  };
  return { calls, fetch: fakeFetch };
}

function driver(options: Partial<SlackDriverOptions> = {}): SlackDriver {
  return new SlackDriver({
    signingSecret: "test-signing-secret",
    token: "xoxb-test",
    ...options,
  });
}

describe("SlackDriver", () => {
  it("posts a formatted threaded reply and generates Block Kit actions", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);
    const result = await driver({ fetch: slack.fetch }).apply(
      [
        {
          type: "post",
          operationId: "op-1",
          content: {
            markdown: "**Ready** for @U2",
            elicitation: {
              id: "approval-1",
              prompt: "**Deploy** version 2.4.1?",
              options: [
                { id: "approve", label: "Approve", style: "primary" },
                { id: "deny", label: "Deny", style: "danger" },
              ],
            },
          },
        },
      ],
      surface,
    );

    expect(result).toEqual({
      applied: [{ operationId: "op-1", messageRef: "1800000001.000001" }],
    });
    expect(slack.calls).toHaveLength(1);
    const params = new URLSearchParams(slack.calls[0]?.body);
    expect(slack.calls[0]?.method).toBe("chat.postMessage");
    expect(params.get("channel")).toBe("C1");
    expect(params.get("thread_ts")).toBe("1800000000.000001");
    expect(params.get("text")).toContain("*Ready* for <@U2>");
    expect(JSON.parse(params.get("blocks") ?? "[]")).toEqual([
      {
        text: { text: "*Ready* for <@U2>", type: "mrkdwn" },
        type: "section",
      },
      {
        text: { text: "*Deploy* version 2.4.1?", type: "mrkdwn" },
        type: "section",
      },
      {
        elements: [
          {
            action_id: "input:approval-1:button:0",
            style: "primary",
            text: { text: "Approve", type: "plain_text" },
            type: "button",
            value: "approve",
          },
          {
            action_id: "input:approval-1:button:1",
            style: "danger",
            text: { text: "Deny", type: "plain_text" },
            type: "button",
            value: "deny",
          },
        ],
        type: "actions",
      },
    ]);
  });

  it("updates the same Slack message reference", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);

    await driver({ fetch: slack.fetch }).apply(
      [
        {
          type: "replace",
          operationId: "op-2",
          messageRef: "1800000001.000001",
          content: { markdown: "**Complete**" },
        },
      ],
      surface,
    );

    const params = new URLSearchParams(slack.calls[0]?.body);
    expect(slack.calls[0]?.method).toBe("chat.update");
    expect(params.get("ts")).toBe("1800000001.000001");
    expect(params.get("text")).toBe("*Complete*");
  });

  it("starts, appends, and stops Slack native streaming", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);

    const result = await driver({ fetch: slack.fetch }).apply(
      [
        { type: "stream-start", operationId: "op-1", initialMarkdown: "Starting" },
        {
          type: "stream-append",
          operationId: "op-2",
          messageRef: "1800000001.000001",
          deltaMarkdown: " the analysis",
        },
        {
          type: "stream-stop",
          operationId: "op-3",
          messageRef: "1800000001.000001",
          elicitation: {
            id: "confirm-1",
            prompt: "Save this result?",
            options: [{ id: "save", label: "Save", style: "primary" }],
          },
        },
      ],
      surface,
    );

    expect(result.applied).toEqual([
      { operationId: "op-1", messageRef: "1800000001.000001" },
      { operationId: "op-2", messageRef: "1800000001.000001" },
      { operationId: "op-3", messageRef: "1800000001.000001" },
    ]);
    expect(slack.calls.map((call) => call.method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(JSON.parse(slack.calls[0]?.body ?? "{}")).toEqual({
      channel: "C1",
      markdown_text: "Starting",
      recipient_team_id: "T1",
      recipient_user_id: "U1",
      thread_ts: "1800000000.000001",
    });
    expect(JSON.parse(slack.calls[1]?.body ?? "{}")).toEqual({
      channel: "C1",
      markdown_text: " the analysis",
      ts: "1800000001.000001",
    });
    const stopped = JSON.parse(slack.calls[2]?.body ?? "{}") as Record<string, unknown>;
    expect(stopped).toMatchObject({ channel: "C1", ts: "1800000001.000001" });
    expect(stopped.blocks).toEqual([
      { text: { text: "Save this result?", type: "mrkdwn" }, type: "section" },
      {
        elements: [
          {
            action_id: "input:confirm-1:button:0",
            style: "primary",
            text: { text: "Save", type: "plain_text" },
            type: "button",
            value: "save",
          },
        ],
        type: "actions",
      },
    ]);
  });

  it("preserves Slack retry-after as a Trema retryable error", async () => {
    const slack = fakeSlack([
      {
        body: { ok: false, error: "ratelimited" },
        status: 429,
        headers: { "retry-after": "7" },
      },
    ]);

    const error = await driver({ fetch: slack.fetch })
      .apply(
        [
          {
            type: "post",
            operationId: "op-1",
            content: { markdown: "Hello" },
          },
        ],
        surface,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({
      category: "rate-limited",
      method: "chat.postMessage",
      retryable: true,
      retryAfterMs: 7_000,
    });
  });

  it("classifies revoked credentials as permanent authentication errors", async () => {
    const slack = fakeSlack([{ body: { ok: false, error: "token_revoked" } }]);

    const error = await driver({ fetch: slack.fetch })
      .apply(
        [
          {
            type: "post",
            operationId: "op-1",
            content: { markdown: "Hello" },
          },
        ],
        surface,
      )
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({
      category: "authentication",
      method: "chat.postMessage",
      retryable: false,
    });
  });

  it("uses the official Slack client fallback without exposing its types", async () => {
    const nativeCall = vi.fn(async () => ({ ok: true }));
    const result = await driver({ nativeCall }).callNative("pins.add", {
      channel: "C1",
      timestamp: "1800000001.000001",
    });

    expect(result).toEqual({ ok: true });
    expect(nativeCall).toHaveBeenCalledWith(
      "pins.add",
      { channel: "C1", timestamp: "1800000001.000001" },
      "xoxb-test",
    );
  });

  it("maps token provider failures into transient surface errors", async () => {
    const error = await driver({
      token: async () => {
        throw new Error("token service unavailable");
      },
    })
      .callNative("pins.add", { channel: "C1", timestamp: "1800000001.000001" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({
      category: "transient",
      method: "pins.add",
      retryable: true,
    });
  });

  it.each([
    ["token_revoked", "authentication"],
    ["channel_not_found", "not-found"],
  ] as const)("classifies native Slack error %s as %s", async (slackError, category) => {
    const nativeCall = vi.fn(async () => {
      throw Object.assign(new Error(slackError), {
        code: "slack_webapi_platform_error",
        data: { error: slackError, ok: false },
      });
    });

    const error = await driver({ nativeCall })
      .callNative("pins.add", { channel: "C1", timestamp: "1800000001.000001" })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({ category, method: "pins.add", retryable: false });
  });
});
