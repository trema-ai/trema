import { describe, expect, it } from "vitest";

import { slackBindingRequest } from "#web/pages/settings/messaging/index.tsx";

describe("slackBindingRequest", () => {
  it("reads and normalizes a Slack channel setup request", () => {
    const params = new URLSearchParams({
      setup: "slack-channel",
      workspaceId: "t123abc",
      channelId: "c456def",
    });

    expect(slackBindingRequest(params)).toEqual({
      workspaceId: "T123ABC",
      channelId: "C456DEF",
    });
  });

  it("rejects unrelated or invalid setup requests", () => {
    expect(slackBindingRequest(new URLSearchParams({ setup: "member" }))).toBeUndefined();
    expect(
      slackBindingRequest(
        new URLSearchParams({
          setup: "slack-channel",
          workspaceId: "T123ABC",
          channelId: "not a Slack ID",
        }),
      ),
    ).toBeUndefined();
  });
});
