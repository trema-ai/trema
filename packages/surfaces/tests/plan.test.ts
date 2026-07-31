import type { Projection } from "@trema/projection";
import {
  acknowledge,
  type CapabilityDescriptor,
  planRender,
  type SurfaceRealization,
} from "@trema/surfaces";
import { describe, expect, it } from "vitest";

const deltaCapabilities: CapabilityDescriptor = {
  mutation: "edit",
  streaming: "delta",
  dialect: "commonmark",
  affordances: {
    buttons: true,
    forms: false,
    reactions: true,
    presence: true,
    threads: true,
    files: true,
  },
  budgets: { messageChars: 1_000, flushIntervalMs: 600, firstPaintMs: 3_000 },
  quirks: {},
};

function projection(
  markdown: string,
  options: {
    lastSeq?: number;
    status?: Projection["status"];
    ended?: boolean;
  } = {},
): Projection {
  return {
    runId: "run-1",
    status: options.status ?? "running",
    segments: [
      {
        index: 0,
        parts: [{ kind: "text", id: "text-1", status: "streaming", markdown }],
        ...(options.ended === true ? { end: { reason: "completed" as const } } : {}),
      },
    ],
    unknownEvents: 0,
    lastSeq: options.lastSeq ?? 1,
  };
}

function realization(overrides: Partial<SurfaceRealization> = {}): SurfaceRealization {
  return {
    id: "realization-1",
    orgId: "org-1",
    runId: "run-1",
    ref: { surface: "test", locationRef: "channel-1", threadRef: "thread-1" },
    renderedThroughSeq: 0,
    segments: [],
    presentation: {},
    version: 0,
    retry: { attempt: 0, terminal: false },
    ...overrides,
  };
}

describe("planRender", () => {
  it("creates an initial realization and then appends only the new projection text", () => {
    const initial = planRender(projection("Hello"), realization(), deltaCapabilities);
    expect(initial.operations).toEqual([
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:0",
        content: expect.objectContaining({ text: "Hello" }),
        finalized: false,
      }),
    ]);

    const applied = acknowledge(initial, {
      appliedOperationIds: initial.operations.map(({ id }) => id),
      messages: [{ messageId: "run-1:segment:0:message:0", remoteRef: "remote-1" }],
    });
    const incremental = planRender(
      projection("Hello world", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments: applied }),
      deltaCapabilities,
    );

    expect(incremental.operations).toEqual([
      expect.objectContaining({ type: "append", remoteRef: "remote-1", text: " world" }),
    ]);
    expect(incremental.nextSegments[0]?.messages[0]?.id).toBe("run-1:segment:0:message:0");
  });

  it("emits no operation when the same projection is replayed", () => {
    const first = planRender(projection("Hello"), realization(), deltaCapabilities);
    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: "run-1:segment:0:message:0", remoteRef: "remote-1" }],
    });
    const replay = planRender(
      projection("Hello"),
      realization({ renderedThroughSeq: 1, segments }),
      deltaCapabilities,
    );

    expect(replay.operations).toEqual([]);
    expect(replay.toCursor).toBe(1);
  });

  it("keeps message identities stable as content grows across budget chunks", () => {
    const smallBudget = {
      ...deltaCapabilities,
      budgets: { ...deltaCapabilities.budgets, messageChars: 5 },
    };
    const first = planRender(projection("Hello"), realization(), smallBudget);
    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: "run-1:segment:0:message:0", remoteRef: "remote-1" }],
    });
    const grown = planRender(
      projection("Hello world", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments }),
      smallBudget,
    );

    expect(grown.nextSegments[0]?.messages.map(({ id }) => id)).toEqual([
      "run-1:segment:0:message:0",
      "run-1:segment:0:message:1",
      "run-1:segment:0:message:2",
    ]);
    expect(grown.operations.map(({ type }) => type)).toEqual(["create", "create"]);
    expect(grown.nextSegments[0]?.messages.every(({ text }) => Array.from(text).length <= 5)).toBe(
      true,
    );
  });

  it("replaces changed content and deletes overflow messages that disappear", () => {
    const capabilities = {
      ...deltaCapabilities,
      streaming: "snapshot" as const,
      budgets: { ...deltaCapabilities.budgets, messageChars: 5 },
    };
    const existing = realization({
      renderedThroughSeq: 3,
      segments: [
        {
          id: "run-1:segment:0",
          index: 0,
          messages: [
            {
              id: "run-1:segment:0:message:0",
              index: 0,
              remoteRef: "remote-1",
              text: "Hello",
              contentHash: "old-1",
              finalized: false,
            },
            {
              id: "run-1:segment:0:message:1",
              index: 1,
              remoteRef: "remote-2",
              text: " world",
              contentHash: "old-2",
              finalized: false,
            },
          ],
        },
      ],
    });

    const plan = planRender(projection("Hallo", { lastSeq: 4 }), existing, capabilities);
    expect(plan.operations).toEqual([
      expect.objectContaining({ type: "replace", remoteRef: "remote-1" }),
      expect.objectContaining({ type: "delete", remoteRef: "remote-2" }),
    ]);
  });

  it("defers render-once delivery until a terminal projection", () => {
    const capabilities: CapabilityDescriptor = {
      ...deltaCapabilities,
      mutation: "render-once",
      streaming: "none",
    };

    const pending = planRender(projection("Hello", { lastSeq: 3 }), realization(), capabilities);
    expect(pending).toMatchObject({ toCursor: 0, operations: [] });

    const terminal = planRender(
      projection("Hello", { lastSeq: 4, status: "completed", ended: true }),
      realization(),
      capabilities,
    );
    expect(terminal.operations).toEqual([
      expect.objectContaining({ type: "create", finalized: true }),
    ]);
    expect(terminal.toCursor).toBe(4);
  });

  it("waits for append-only segment boundaries and sends later changes as follow-ups", () => {
    const capabilities: CapabilityDescriptor = {
      ...deltaCapabilities,
      mutation: "append-only",
      streaming: "none",
    };
    expect(planRender(projection("Hello"), realization(), capabilities).operations).toEqual([]);

    const first = planRender(projection("Hello", { ended: true }), realization(), capabilities);
    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: first.operations[0]!.messageId, remoteRef: "remote-1" }],
    });
    const changed = planRender(
      projection("Hello again", { lastSeq: 2, ended: true }),
      realization({ renderedThroughSeq: 1, segments }),
      capabilities,
    );

    expect(changed.operations).toEqual([
      expect.objectContaining({
        type: "create",
        messageId: expect.stringContaining(":revision:"),
        finalized: true,
      }),
    ]);
    expect(changed.nextSegments[0]?.messages).toHaveLength(2);
  });

  it("requires complete acknowledgement before state can commit", () => {
    const plan = planRender(projection("Hello"), realization(), deltaCapabilities);
    expect(() => acknowledge(plan, { appliedOperationIds: [], messages: [] })).toThrow(
      "complete render batch",
    );
    expect(() =>
      acknowledge(plan, {
        appliedOperationIds: plan.operations.map(({ id }) => id),
        messages: [],
      }),
    ).toThrow("omitted remote reference");
  });
});
