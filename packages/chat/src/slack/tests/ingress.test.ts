import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { SurfaceDriverError } from "#chat/index.js";
import { SlackIngressDriver } from "#chat/slack/index.js";

const SIGNING_SECRET = "test-signing-secret";
const NOW_SECONDS = 1_800_000_000;

function signedRequest(
  body: string,
  options: {
    contentType?: string;
    timestamp?: number;
    retry?: { attempt: number; reason: string };
  } = {},
): Request {
  const timestamp = options.timestamp ?? NOW_SECONDS;
  const signature = `v0=${createHmac("sha256", SIGNING_SECRET)
    .update(`v0:${timestamp}:${body}`)
    .digest("hex")}`;
  const headers = new Headers({
    "content-type": options.contentType ?? "application/json",
    "x-slack-request-timestamp": String(timestamp),
    "x-slack-signature": signature,
  });
  if (options.retry !== undefined) {
    headers.set("x-slack-retry-num", String(options.retry.attempt));
    headers.set("x-slack-retry-reason", options.retry.reason);
  }
  return new Request("https://trema.test/ingress/slack/events", {
    body,
    headers,
    method: "POST",
  });
}

function driver(): SlackIngressDriver {
  return new SlackIngressDriver({
    signingSecret: SIGNING_SECRET,
    now: () => NOW_SECONDS * 1_000,
  });
}

describe("Slack ingress driver", () => {
  it("verifies and normalizes an app mention without leaking Slack payload types", async () => {
    const body = JSON.stringify({
      api_app_id: "A1",
      event: {
        channel: "C1",
        event_ts: "1800000000.000002",
        text: "<@UBOT> investigate the deploy",
        thread_ts: "1800000000.000001",
        ts: "1800000000.000002",
        type: "app_mention",
        user: "U1",
      },
      event_id: "Ev1",
      event_time: NOW_SECONDS,
      team_id: "T1",
      type: "event_callback",
    });

    await expect(
      driver().read(
        signedRequest(body, {
          retry: { attempt: 1, reason: "http_timeout" },
        }),
      ),
    ).resolves.toEqual({
      type: "message",
      surface: "slack",
      intentId: "slack:event:Ev1",
      surfaceRef: {
        surface: "slack",
        locationRef: "T1:C1",
        channelRef: "C1",
        threadRef: "1800000000.000001",
        teamRef: "T1",
      },
      authorRef: "U1",
      text: "<@UBOT> investigate the deploy",
      at: "2027-01-15T08:00:00.000Z",
      nativeKind: "app-mention",
      retry: { attempt: 1, reason: "http_timeout" },
    });
  });

  it("normalizes Block Kit input actions into Trema resolution facts", async () => {
    const payload = {
      actions: [
        {
          action_id: "input:approval-1:button:0",
          action_ts: "1800000001.000001",
          block_id: "actions-1",
          text: { text: "Approve", type: "plain_text" },
          type: "button",
          value: "approve",
        },
      ],
      api_app_id: "A1",
      channel: { id: "C1", name: "deploys" },
      message: {
        thread_ts: "1800000000.000001",
        ts: "1800000000.000003",
      },
      team: { domain: "trema", id: "T1" },
      token: "deprecated-verification-token",
      trigger_id: "trigger-1",
      type: "block_actions",
      user: { id: "U1", name: "nelson", team_id: "T1", username: "nelson" },
    };
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

    await expect(
      driver().read(signedRequest(body, { contentType: "application/x-www-form-urlencoded" })),
    ).resolves.toEqual({
      type: "interaction",
      surface: "slack",
      intentId: "slack:interaction:trigger-1",
      authorRef: "U1",
      surfaceRef: {
        surface: "slack",
        locationRef: "T1:C1",
        channelRef: "C1",
        threadRef: "1800000000.000001",
        teamRef: "T1",
      },
      action: {
        type: "resolve",
        elicitationId: "approval-1",
        optionId: "approve",
      },
    });
  });

  it("returns URL verification challenges", async () => {
    const body = JSON.stringify({ challenge: "challenge-1", type: "url_verification" });

    await expect(driver().read(signedRequest(body))).resolves.toEqual({
      type: "challenge",
      surface: "slack",
      challenge: "challenge-1",
    });
  });

  it("preserves unsupported native payloads for downstream adapter handling", async () => {
    const payload = {
      event: {
        item: { channel: "C1", ts: "1800000000.000001", type: "message" },
        reaction: "eyes",
        type: "reaction_added",
        user: "U1",
      },
      event_id: "Ev2",
      team_id: "T1",
      type: "event_callback",
    };
    const body = JSON.stringify(payload);

    await expect(driver().read(signedRequest(body))).resolves.toEqual({
      type: "unsupported",
      surface: "slack",
      nativeType: "reaction_added",
      nativePayload: payload,
    });
  });

  it("rejects signatures outside Slack's replay window", async () => {
    const body = JSON.stringify({ challenge: "challenge-1", type: "url_verification" });
    const request = signedRequest(body, { timestamp: NOW_SECONDS - 301 });

    const error = await driver()
      .read(request)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({
      category: "invalid-request",
      method: "webhook.verify",
      retryable: false,
    });
  });
});
