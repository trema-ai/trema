import { envelope, log, principal, resolvedAt, usage } from "@trema/projection/testing";
import { describe, expect, it } from "vitest";
import { advance, fold } from "#projection/fold.js";

describe("fold tolerance", () => {
  it("counts and skips unknown event types", () => {
    const projection = fold("run-1", [
      envelope(1, { type: "run-started", trigger: "message" }),
      envelope(2, { type: "future-event", payload: 42 }),
      envelope(3, { type: "text-delta", blockId: "text-1", delta: "hi" }),
    ]);

    expect(projection.unknownEvents).toBe(1);
    expect(projection.lastSeq).toBe(3);
    expect(projection.segments[0]?.parts).toStrictEqual([
      { kind: "text", id: "text-1", status: "streaming", markdown: "hi" },
    ]);
  });

  it("counts and skips malformed known events instead of throwing", () => {
    const projection = fold("run-1", [
      envelope(1, { type: "text-delta", blockId: "text-1" }),
      envelope(2, "not even an object"),
    ]);

    expect(projection.unknownEvents).toBe(2);
    expect(projection.segments).toStrictEqual([]);
    expect(projection.lastSeq).toBe(2);
  });

  it("never turns transient data events into parts", () => {
    const projection = fold("run-1", [
      envelope(1, { type: "data", name: "heartbeat", data: null, transient: true }),
    ]);

    expect(projection.segments).toStrictEqual([]);
    expect(projection.unknownEvents).toBe(0);
    expect(projection.lastSeq).toBe(1);
  });

  it("tolerates an orphan resolution", () => {
    const projection = fold("run-1", [
      envelope(1, {
        type: "elicitation-resolved",
        elicitationId: "elicit-missing",
        optionId: "approve",
        by: principal,
        at: resolvedAt,
      }),
    ]);

    expect(projection.segments).toStrictEqual([]);
    expect(projection.unknownEvents).toBe(0);
  });
});

describe("data reconciliation", () => {
  it("reconciles data parts by id in place", () => {
    const projection = fold(
      "run-1",
      log([
        { type: "data", name: "chart", id: "chart-1", data: { points: 1 } },
        { type: "steering", author: principal, text: "keep going" },
        { type: "data", name: "chart-final", id: "chart-1", data: { points: 2 } },
      ]),
    );

    expect(projection.segments[0]?.parts).toStrictEqual([
      { kind: "data", id: "chart-1", name: "chart-final", data: { points: 2 } },
      { kind: "steering", id: "steering-2", author: principal, text: "keep going" },
    ]);
  });

  it("appends id-less data events under synthesized ids", () => {
    // The model adapter emits `data { name: <part.kind>, data: providerMetadata ?? null }`
    // with no id: every such event is its own part.
    const projection = fold(
      "run-1",
      log([
        { type: "data", name: "text", data: null },
        { type: "data", name: "text", data: null },
      ]),
    );

    expect(projection.segments[0]?.parts).toStrictEqual([
      { kind: "data", id: "text#1", name: "text", data: null },
      { kind: "data", id: "text#2", name: "text", data: null },
    ]);
  });
});

describe("implicit opens", () => {
  it("opens a text block from a bare delta", () => {
    const projection = fold("run-1", log([{ type: "text-delta", blockId: "text-1", delta: "hi" }]));

    expect(projection.segments[0]?.parts).toStrictEqual([
      { kind: "text", id: "text-1", status: "streaming", markdown: "hi" },
    ]);
  });

  it("reopens a settled activity when its call starts again", () => {
    const projection = fold(
      "run-1",
      log([
        { type: "tool-note", callId: "call-9", note: "queued" },
        { type: "tool-result", callId: "call-9", status: "ok", summary: "first attempt" },
        {
          type: "tool-start",
          callId: "call-9",
          name: "shell",
          title: "Run shell",
          kind: "execute",
        },
        { type: "tool-input-delta", callId: "call-9", delta: "ls" },
      ]),
    );

    const part = projection.segments[0]?.parts[0];
    expect(part).toMatchObject({
      kind: "activity",
      status: "streaming",
      name: "shell",
      title: "Run shell",
      toolKind: "execute",
      input: "ls",
    });
  });

  it("opens an activity with placeholders from a bare note", () => {
    const projection = fold(
      "run-1",
      log([{ type: "tool-note", callId: "call-9", note: "still working" }]),
    );

    expect(projection.segments[0]?.parts).toStrictEqual([
      {
        kind: "activity",
        id: "call-9",
        status: "streaming",
        callId: "call-9",
        name: "unknown",
        title: "Tool call",
        toolKind: "other",
        notes: ["still working"],
      },
    ]);
  });
});

describe("settle-before-close", () => {
  it("settles streaming parts on turn-finished and records the error on open activities", () => {
    const projection = fold(
      "run-1",
      log([
        { type: "text-start", blockId: "text-1" },
        { type: "text-delta", blockId: "text-1", delta: "partial" },
        { type: "tool-start", callId: "call-1", name: "lookup", title: "Lookup", kind: "search" },
        { type: "turn-finished", turn: 0, stopReason: "error", usage },
      ]),
    );

    expect(projection.segments[0]?.parts).toStrictEqual([
      { kind: "text", id: "text-1", status: "done", markdown: "partial" },
      {
        kind: "activity",
        id: "call-1",
        status: "done",
        callId: "call-1",
        name: "lookup",
        title: "Lookup",
        toolKind: "search",
        notes: [],
        result: { status: "error", summary: "turn ended: error" },
      },
    ]);
  });

  it("settles a dangling streaming block on run-finished", () => {
    const projection = fold(
      "run-1",
      log([
        { type: "run-started", trigger: "message" },
        { type: "reasoning-delta", blockId: "reasoning-1", delta: "thinking" },
        { type: "run-finished", outcome: "failed", errorMessage: "provider failed" },
      ]),
    );

    expect(projection.status).toBe("failed");
    expect(projection.segments[0]?.parts).toStrictEqual([
      { kind: "reasoning", id: "reasoning-1", status: "done", text: "thinking" },
    ]);
  });
});

describe("provider-scoped block ids", () => {
  it("keeps repeated text and reasoning ids in event order across model requests", () => {
    const projection = fold(
      "run-1",
      log([
        { type: "reasoning-start", blockId: "reasoning-0" },
        { type: "reasoning-delta", blockId: "reasoning-0", delta: "first thought" },
        { type: "reasoning-end", blockId: "reasoning-0" },
        { type: "text-start", blockId: "text-0" },
        { type: "text-delta", blockId: "text-0", delta: "I will check." },
        { type: "text-end", blockId: "text-0" },
        {
          type: "tool-start",
          callId: "call-1",
          name: "lookup",
          title: "Lookup",
          kind: "search",
        },
        {
          type: "tool-result",
          callId: "call-1",
          status: "ok",
          summary: "Found it",
        },
        { type: "reasoning-start", blockId: "reasoning-0" },
        { type: "reasoning-delta", blockId: "reasoning-0", delta: "second thought" },
        { type: "reasoning-end", blockId: "reasoning-0" },
        { type: "text-start", blockId: "text-0" },
        { type: "text-delta", blockId: "text-0", delta: "Here is the answer." },
        { type: "text-end", blockId: "text-0" },
      ]),
    );

    expect(
      projection.segments[0]?.parts.map((part) =>
        part.kind === "text"
          ? `${part.kind}:${part.markdown}`
          : part.kind === "reasoning"
            ? `${part.kind}:${part.text}`
            : part.kind,
      ),
    ).toStrictEqual([
      "reasoning:first thought",
      "text:I will check.",
      "activity",
      "reasoning:second thought",
      "text:Here is the answer.",
    ]);
  });
});

describe("segments and resolutions", () => {
  it("mutates an elicitation in a prior, closed segment without reopening it", () => {
    const parked = fold(
      "run-1",
      log([
        {
          type: "elicitation",
          elicitationId: "elicit-1",
          kind: "approval",
          prompt: "Proceed?",
          options: [{ id: "approve", label: "Approve" }],
          blocking: true,
        },
        { type: "segment-end", reason: "paused" },
      ]),
    );

    const resolved = advance(parked, [
      envelope(3, {
        type: "elicitation-resolved",
        elicitationId: "elicit-1",
        optionId: "approve",
        by: principal,
        at: resolvedAt,
      }),
      envelope(4, { type: "steering", author: principal, text: "resumed" }),
    ]);

    expect(resolved.segments[0]?.end).toStrictEqual({ reason: "paused" });
    expect(resolved.segments[0]?.parts[0]).toMatchObject({
      kind: "elicitation",
      resolution: { optionId: "approve", by: principal, at: resolvedAt },
    });
    expect(resolved.segments[1]).toMatchObject({ index: 1, parts: [{ kind: "steering" }] });
  });

  it("does not materialize an empty trailing segment after segment-end", () => {
    const projection = fold(
      "run-1",
      log([
        { type: "text-start", blockId: "text-1" },
        { type: "text-end", blockId: "text-1" },
        { type: "segment-end", reason: "completed" },
        { type: "run-finished", outcome: "completed" },
      ]),
    );

    expect(projection.segments).toHaveLength(1);
  });
});

describe("advance", () => {
  const events = log([
    { type: "run-started", trigger: "message" },
    { type: "text-start", blockId: "text-1" },
    { type: "text-delta", blockId: "text-1", delta: "hello" },
  ]);

  it("skips duplicate and stale seqs", () => {
    const projection = fold("run-1", events);

    const redelivered = advance(projection, events);
    expect(redelivered).toBe(projection);

    const overlapping = advance(projection, [
      ...events,
      envelope(3, { type: "text-delta", blockId: "text-1", delta: " ignored duplicate" }),
      envelope(4, { type: "text-end", blockId: "text-1" }),
    ]);
    expect(overlapping.segments[0]?.parts).toStrictEqual([
      { kind: "text", id: "text-1", status: "done", markdown: "hello" },
    ]);
    expect(overlapping.lastSeq).toBe(4);
  });

  it("never mutates its input projection", () => {
    const projection = fold("run-1", events);
    const snapshot = JSON.parse(JSON.stringify(projection));

    advance(projection, [
      envelope(4, { type: "text-delta", blockId: "text-1", delta: " world" }),
      envelope(5, { type: "run-finished", outcome: "completed", usage }),
    ]);

    expect(projection).toStrictEqual(snapshot);
  });

  it("shares untouched segments and parts by reference", () => {
    const parked = fold(
      "run-1",
      log([
        { type: "text-start", blockId: "text-1" },
        { type: "text-end", blockId: "text-1" },
        { type: "segment-end", reason: "completed" },
      ]),
    );

    const advanced = advance(parked, [
      envelope(4, { type: "steering", author: principal, text: "next" }),
    ]);

    expect(advanced).not.toBe(parked);
    expect(advanced.segments[0]).toBe(parked.segments[0]);
  });
});
