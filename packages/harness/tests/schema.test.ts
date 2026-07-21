import { describe, expect, it } from "vitest";
import type { RunEventData } from "#/events/schema.js";
import { parseRunEvent, RunEventSchema } from "#/events/schema.js";

const usage = {
  inputTokens: 2,
  outputTokens: 3,
  totalTokens: 5,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

const principal = { principalId: "principal-1", displayName: "Nelson" };

const events: RunEventData[] = [
  { type: "run-started", trigger: "message" },
  { type: "run-finished", outcome: "completed", usage },
  { type: "turn-started", turn: 0, model: "openrouter/model" },
  { type: "turn-finished", turn: 0, stopReason: "stop", usage },
  { type: "text-start", blockId: "text-1" },
  { type: "text-delta", blockId: "text-1", delta: "hello" },
  { type: "text-end", blockId: "text-1" },
  { type: "reasoning-start", blockId: "reasoning-1" },
  { type: "reasoning-delta", blockId: "reasoning-1", delta: "hmm" },
  { type: "reasoning-end", blockId: "reasoning-1", redacted: true },
  { type: "tool-start", callId: "call-1", name: "read", title: "Read", kind: "read" },
  { type: "tool-input-delta", callId: "call-1", delta: "{}" },
  { type: "tool-input", callId: "call-1", input: {} },
  { type: "tool-note", callId: "call-1", note: "working" },
  { type: "tool-result", callId: "call-1", status: "ok", summary: "done" },
  {
    type: "elicitation",
    elicitationId: "elicit-1",
    kind: "approval",
    prompt: "Proceed?",
    reference: { callId: "call-1", approvalId: "approval-1" },
    options: [{ id: "yes", label: "Yes", scope: "once" }],
    blocking: true,
  },
  {
    type: "elicitation-resolved",
    elicitationId: "elicit-1",
    optionId: "yes",
    by: principal,
    at: "2026-07-19T12:00:01.000Z",
  },
  { type: "segment-end", reason: "paused" },
  { type: "steering", author: principal, text: "also check staging" },
  { type: "error", message: "model failed", recoverable: true },
  { type: "data", name: "compaction", id: "compact-1", data: { removed: 2 } },
];

describe("RunEventSchema", () => {
  it.each(events.map((event, index) => [event.type, event, index + 1] as const))(
    "round-trips %s",
    (_type, event, seq) => {
      const envelope = {
        runId: "run-1",
        seq,
        at: "2026-07-19T12:00:00.000Z",
        v: 1 as const,
        event,
      };

      expect(RunEventSchema.parse(envelope)).toEqual(envelope);
      expect(parseRunEvent(envelope)).toEqual({ kind: "known", value: envelope });
    },
  );

  it("accepts and ignores unknown fields", () => {
    const parsed = parseRunEvent({
      runId: "run-1",
      seq: 1,
      at: "2026-07-19T12:00:00.000Z",
      v: 1,
      futureEnvelopeField: true,
      event: { type: "text-start", blockId: "text-1", futureEventField: true },
    });

    expect(parsed).toEqual({
      kind: "known",
      value: {
        runId: "run-1",
        seq: 1,
        at: "2026-07-19T12:00:00.000Z",
        v: 1,
        event: { type: "text-start", blockId: "text-1" },
      },
    });
  });

  it("returns unknown event types for readers to skip", () => {
    const parsed = parseRunEvent({
      runId: "run-1",
      seq: 2,
      at: "2026-07-19T12:00:00.000Z",
      v: 1,
      event: { type: "future-event", payload: 42 },
    });

    expect(parsed).toEqual({
      kind: "unknown",
      value: {
        runId: "run-1",
        seq: 2,
        at: "2026-07-19T12:00:00.000Z",
        v: 1,
        event: { type: "future-event", payload: 42 },
      },
    });
  });

  it("does not treat malformed known events as unknown", () => {
    expect(() =>
      parseRunEvent({
        runId: "run-1",
        seq: 3,
        at: "2026-07-19T12:00:00.000Z",
        v: 1,
        event: { type: "text-delta", blockId: "text-1" },
      }),
    ).toThrow();
  });
});
