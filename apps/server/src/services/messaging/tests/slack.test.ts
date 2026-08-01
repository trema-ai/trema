import { describe, expect, it } from "vitest";

import {
  SLACK_EVENTS_PATH,
  SLACK_INTERACTIONS_PATH,
  SlackMessagingValidationError,
  slackAppManifest,
  slackExternalUserRef,
  slackLocationRef,
} from "#server/services/messaging/index.js";

describe("Slack messaging configuration", () => {
  it("generates a deployment-specific least-privilege app manifest", () => {
    const manifest = slackAppManifest("https://auth.trema.example/base");

    expect(manifest.oauth_config.redirect_urls).toEqual([
      "https://auth.trema.example/connect/callback",
    ]);
    expect(manifest.settings.event_subscriptions.request_url).toBe(
      `https://auth.trema.example${SLACK_EVENTS_PATH}`,
    );
    expect(manifest.settings.interactivity.request_url).toBe(
      `https://auth.trema.example${SLACK_INTERACTIONS_PATH}`,
    );
    expect(manifest.settings.token_rotation_enabled).toBe(true);
    expect(manifest.oauth_config.scopes.bot).toEqual(
      expect.arrayContaining([
        "app_mentions:read",
        "channels:history",
        "chat:write",
        "groups:history",
        "im:history",
        "mpim:history",
        "users:read",
      ]),
    );
    expect(manifest.oauth_config.scopes.bot).not.toContain("admin");
    expect(manifest.oauth_config.scopes.user).toEqual(["users:read"]);
  });

  it("builds workspace-scoped location and requester references", () => {
    expect(slackLocationRef("T123ABC", "C456DEF")).toBe("T123ABC:C456DEF");
    expect(slackExternalUserRef("T123ABC", "U456DEF")).toBe("T123ABC:U456DEF");
  });

  it("rejects malformed Slack identifiers before persistence", () => {
    expect(() => slackLocationRef("other-org", "C456DEF")).toThrow(SlackMessagingValidationError);
    expect(() => slackExternalUserRef("T123ABC", "some-user")).toThrow(
      SlackMessagingValidationError,
    );
  });
});
