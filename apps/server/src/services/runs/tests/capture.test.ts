import type { TranscriptMessage } from "@trema/harness";
import { describe, expect, it } from "vitest";

import { MESSAGE_BATCH_LIMIT } from "#server/services/conversations/index.js";
import {
  messageBatches,
  openingMessages,
  type QueuedMessage,
} from "#server/services/runs/capture.js";

const queuedAt = new Date("2026-07-19T12:00:00.000Z");

function queued(
  id: string,
  principalId: string,
  message: TranscriptMessage["blocks"],
): QueuedMessage {
  return {
    id,
    author: { principalId, displayName: "Nelson" },
    message: { role: "user", blocks: message },
    queuedAt,
  };
}

function text(...texts: string[]): TranscriptMessage["blocks"] {
  return texts.map((value) => ({ type: "text", text: value }));
}

describe("opening messages", () => {
  const humans = new Set(["principal-1"]);

  it("reports a person's message under the queue entry's id", () => {
    expect(
      openingMessages([queued("intent-1", "principal-1", text("Check the deploy."))], humans),
    ).toEqual([
      {
        surfaceMessageRef: "intent-1",
        author: { principalId: "principal-1" },
        sentAt: queuedAt,
        text: "Check the deploy.",
      },
    ]);
  });

  it("keeps the reference stable, so a redelivered execution reports the same message", () => {
    const input = [queued("intent-1", "principal-1", text("Check the deploy."))];

    expect(openingMessages(input, humans)).toEqual(openingMessages(input, humans));
  });

  it("drops a message no person authored", () => {
    // A schedule or a service credential started this run; a conversation is
    // what people said.
    expect(openingMessages([queued("intent-1", "agent-1", text("Summarize."))], humans)).toEqual(
      [],
    );
  });

  it("drops a message with nothing to index", () => {
    expect(
      openingMessages(
        [
          queued("intent-1", "principal-1", [
            { type: "image", data: "aGk=", mediaType: "image/png" },
          ]),
          queued("intent-2", "principal-1", text("   ")),
        ],
        humans,
      ),
    ).toEqual([]);
  });

  it("splits a queue too long to report in one call", () => {
    const captured = openingMessages(
      Array.from({ length: MESSAGE_BATCH_LIMIT + 1 }, (_, index) =>
        queued(`intent-${index}`, "principal-1", text(`Message ${index}.`)),
      ),
      humans,
    );
    const batches = messageBatches(captured);

    // The loop drains the queue whatever happens, so a batch the conversation
    // service would refuse is a message lost for good.
    expect(batches.map(({ length }) => length)).toEqual([MESSAGE_BATCH_LIMIT, 1]);
    expect(batches.flat()).toEqual(captured);
    expect(messageBatches(captured.slice(0, MESSAGE_BATCH_LIMIT))).toEqual([
      captured.slice(0, MESSAGE_BATCH_LIMIT),
    ]);
    expect(messageBatches([])).toEqual([]);
  });

  it("joins a message's text blocks and keeps queue order", () => {
    const captured = openingMessages(
      [
        queued("intent-1", "principal-1", text("Check the deploy.", "And the migration.")),
        queued("intent-2", "principal-1", text("Thanks.")),
      ],
      humans,
    );

    expect(
      captured.map(({ surfaceMessageRef, text: value }) => [surfaceMessageRef, value]),
    ).toEqual([
      ["intent-1", "Check the deploy.\nAnd the migration."],
      ["intent-2", "Thanks."],
    ]);
  });
});
