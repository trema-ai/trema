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
    reconciliationRequired: false,
    nativeStopPending: false,
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
      messages: [
        {
          messageId: "run-1:segment:0:message:0",
          remoteRef: "remote-1",
          metadata: { streamCursor: "durable-driver-state" },
        },
      ],
    });
    const incremental = planRender(
      projection("Hello world", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments: applied }),
      deltaCapabilities,
    );

    expect(incremental.operations).toEqual([
      expect.objectContaining({
        type: "append",
        remoteRef: "remote-1",
        text: " world",
        prior: {
          text: "Hello",
          metadata: { streamCursor: "durable-driver-state" },
        },
      }),
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

  it("rejects stale cursor regression unless authoritative truncation was confirmed", () => {
    const first = planRender(projection("Hello", { lastSeq: 3 }), realization(), deltaCapabilities);
    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: "run-1:segment:0:message:0", remoteRef: "remote-1" }],
    });
    const current = realization({ renderedThroughSeq: 3, segments, version: 1 });
    const regressed = projection("Hallo", { lastSeq: 2 });

    expect(() => planRender(regressed, current, deltaCapabilities)).toThrow(
      "projection cursor regressed",
    );
    const reconciled = planRender(regressed, current, deltaCapabilities, {
      allowCursorRegression: true,
    });
    expect(reconciled).toMatchObject({ fromCursor: 3, toCursor: 2 });
    expect(reconciled.operations).toEqual([
      expect.objectContaining({ type: "replace", remoteRef: "remote-1" }),
    ]);
  });

  it("keeps a create idempotency key stable when the projection cursor advances", () => {
    const first = planRender(projection("Hello"), realization(), deltaCapabilities);
    const retried = planRender(
      projection("Hello world", { lastSeq: 2 }),
      realization(),
      deltaCapabilities,
    );

    expect(first.operations[0]?.type).toBe("create");
    expect(retried.operations[0]?.id).toBe(first.operations[0]?.id);
  });

  it("keeps mutation idempotency keys stable across failure version increments", () => {
    const first = planRender(projection("Hello"), realization(), deltaCapabilities);
    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: first.operations[0]!.messageId, remoteRef: "remote-1" }],
    });
    const beforeFailure = planRender(
      projection("Hello world", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments, version: 1 }),
      deltaCapabilities,
    );
    const afterFailure = planRender(
      projection("Hello world", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments, version: 2 }),
      deltaCapabilities,
    );

    expect(beforeFailure.operations[0]).toMatchObject({ type: "append", text: " world" });
    expect(afterFailure.operations[0]?.id).toBe(beforeFailure.operations[0]?.id);
  });

  it("replays a staged unknown apply before planning a reverted projection", () => {
    const first = planRender(projection("A"), realization(), deltaCapabilities);
    const firstSegments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: first.operations[0]!.messageId, remoteRef: "remote-1" }],
    });
    const changed = planRender(
      projection("B", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments: firstSegments, version: 1 }),
      deltaCapabilities,
    );

    const retry = planRender(
      projection("A", { lastSeq: 3 }),
      realization({
        renderedThroughSeq: 1,
        segments: firstSegments,
        pendingPlan: changed,
        version: 2,
      }),
      deltaCapabilities,
    );
    expect(retry).toEqual(changed);

    const changedSegments = acknowledge(retry, {
      appliedOperationIds: retry.operations.map(({ id }) => id),
      messages: [],
    });
    const reverted = planRender(
      projection("A", { lastSeq: 3 }),
      realization({ renderedThroughSeq: 2, segments: changedSegments, version: 3 }),
      deltaCapabilities,
    );
    expect(reverted.operations).toEqual([
      expect.objectContaining({
        type: "replace",
        remoteRef: "remote-1",
        content: expect.objectContaining({ text: "A" }),
      }),
    ]);
  });

  it("plans an authoritative follow-up after a staged batch crosses a truncation", () => {
    const first = planRender(projection("A"), realization(), deltaCapabilities);
    const firstSegments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: first.operations[0]!.messageId, remoteRef: "remote-1" }],
    });
    const changed = planRender(
      projection("B", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 1, segments: firstSegments, version: 1 }),
      deltaCapabilities,
    );

    const truncatedRetry = planRender(
      projection("A", { lastSeq: 1 }),
      realization({
        renderedThroughSeq: 1,
        segments: firstSegments,
        pendingPlan: changed,
        version: 2,
      }),
      deltaCapabilities,
      { allowCursorRegression: true },
    );
    expect(truncatedRetry).toMatchObject({ fromCursor: 1, toCursor: 1 });
    expect(truncatedRetry.operations).toEqual(changed.operations);

    const changedSegments = acknowledge(truncatedRetry, {
      appliedOperationIds: truncatedRetry.operations.map(({ id }) => id),
      messages: [],
    });
    const reconciled = planRender(
      projection("A", { lastSeq: 1 }),
      realization({
        renderedThroughSeq: 1,
        segments: changedSegments,
        reconciliationRequired: true,
        version: 3,
      }),
      deltaCapabilities,
    );
    expect(reconciled.operations).toEqual([
      expect.objectContaining({
        type: "replace",
        remoteRef: "remote-1",
        content: expect.objectContaining({ text: "A" }),
      }),
    ]);
  });

  it("uses a snapshot when a delta would cross more than one unapplied event", () => {
    const first = planRender(projection("Hello"), realization(), deltaCapabilities);
    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: "run-1:segment:0:message:0", remoteRef: "remote-1" }],
    });

    const recovered = planRender(
      projection("Hello world", { lastSeq: 3 }),
      realization({ renderedThroughSeq: 1, segments }),
      deltaCapabilities,
    );

    expect(recovered.operations).toEqual([
      expect.objectContaining({ type: "replace", remoteRef: "remote-1" }),
    ]);
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

  it("attaches only the source parts represented by each overflow message", () => {
    const smallBudget = {
      ...deltaCapabilities,
      budgets: { ...deltaCapabilities.budgets, messageChars: 7 },
    };
    const input: Projection = {
      ...projection("unused"),
      segments: [
        {
          index: 0,
          parts: [
            { kind: "text", id: "text-1", status: "done", markdown: "Alpha" },
            { kind: "text", id: "text-2", status: "done", markdown: "Beta" },
          ],
        },
      ],
    };

    const plan = planRender(input, realization(), smallBudget);
    const creates = plan.operations.filter((operation) => operation.type === "create");
    expect(creates.map(({ content }) => content.text)).toEqual(["Alpha", "Beta"]);
    expect(creates.map(({ content }) => content.parts.map((part) => part.id))).toEqual([
      ["text-1"],
      ["text-2"],
    ]);
  });

  it("preserves rich data parts and replaces them when their payload changes", () => {
    const withData = (value: number, lastSeq: number): Projection => ({
      ...projection("unused", { lastSeq }),
      segments: [
        {
          index: 0,
          parts: [{ kind: "data", id: "chart-1", name: "chart", data: { value } }],
        },
      ],
    });
    const first = planRender(withData(1, 1), realization(), deltaCapabilities);
    expect(first.operations).toEqual([
      expect.objectContaining({
        type: "create",
        content: {
          text: "",
          parts: [expect.objectContaining({ kind: "data", data: { value: 1 } })],
        },
      }),
    ]);

    const segments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: first.operations[0]!.messageId, remoteRef: "remote-data" }],
    });
    const changed = planRender(
      withData(2, 2),
      realization({ renderedThroughSeq: 1, segments, version: 1 }),
      deltaCapabilities,
    );
    expect(changed.operations).toEqual([
      expect.objectContaining({
        type: "replace",
        remoteRef: "remote-data",
        content: expect.objectContaining({
          parts: [expect.objectContaining({ kind: "data", data: { value: 2 } })],
        }),
      }),
    ]);
  });

  it("removes redacted reasoning text from driver-visible typed parts", () => {
    const input: Projection = {
      ...projection("unused"),
      segments: [
        {
          index: 0,
          parts: [
            {
              kind: "reasoning",
              id: "reasoning-1",
              status: "done",
              text: "private chain of thought",
              redacted: true,
            },
          ],
        },
      ],
    };

    const plan = planRender(input, realization(), deltaCapabilities);
    expect(plan.operations).toEqual([
      expect.objectContaining({
        type: "create",
        content: {
          text: "Reasoning redacted",
          parts: [expect.objectContaining({ kind: "reasoning", redacted: true, text: "" })],
        },
      }),
    ]);
    expect(JSON.stringify(plan.operations)).not.toContain("private chain of thought");
  });

  it("keeps every overflowed fenced-code message syntactically balanced", () => {
    const codeBudget = {
      ...deltaCapabilities,
      budgets: { ...deltaCapabilities.budgets, messageChars: 24 },
    };
    const markdown = "Intro\n\n```ts\nconst alpha = 1;\nconst beta = 2;\n```\n\nOutro";
    const plan = planRender(projection(markdown), realization(), codeBudget);
    const creates = plan.operations.filter((operation) => operation.type === "create");

    expect(creates.length).toBeGreaterThan(1);
    for (const operation of creates) {
      expect(Array.from(operation.content.text).length).toBeLessThanOrEqual(24);
      const fences = operation.content.text.match(/^```/gm) ?? [];
      expect(fences.length % 2).toBe(0);
    }
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

    const segments = acknowledge(terminal, {
      appliedOperationIds: terminal.operations.map(({ id }) => id),
      messages: [{ messageId: terminal.operations[0]!.messageId, remoteRef: "remote-1" }],
    });
    const reconciled = planRender(
      projection("Changed", { lastSeq: 2, status: "completed", ended: true }),
      realization({ renderedThroughSeq: 4, segments, version: 1 }),
      capabilities,
      { allowCursorRegression: true },
    );
    expect(reconciled).toEqual({
      fromCursor: 4,
      toCursor: 2,
      operations: [],
      nextSegments: segments,
    });
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

  it("compares append-only content with the latest logical-message revision", () => {
    const capabilities: CapabilityDescriptor = {
      ...deltaCapabilities,
      mutation: "append-only",
      streaming: "none",
    };
    const first = planRender(projection("A", { ended: true }), realization(), capabilities);
    const firstSegments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: [{ messageId: first.operations[0]!.messageId, remoteRef: "remote-a-1" }],
    });
    const second = planRender(
      projection("B", { lastSeq: 2, ended: true }),
      realization({ renderedThroughSeq: 1, segments: firstSegments, version: 1 }),
      capabilities,
    );
    const secondSegments = acknowledge(second, {
      appliedOperationIds: second.operations.map(({ id }) => id),
      messages: [{ messageId: second.operations[0]!.messageId, remoteRef: "remote-b" }],
    });

    const reverted = planRender(
      projection("A", { lastSeq: 3, ended: true }),
      realization({ renderedThroughSeq: 2, segments: secondSegments, version: 2 }),
      capabilities,
    );
    expect(reverted.operations).toEqual([
      expect.objectContaining({
        type: "create",
        messageId: expect.stringContaining(":revision:2"),
      }),
    ]);
    const retried = planRender(
      projection("A", { lastSeq: 3, ended: true }),
      realization({ renderedThroughSeq: 2, segments: secondSegments, version: 2 }),
      capabilities,
    );
    expect(retried.operations[0]?.id).toBe(reverted.operations[0]?.id);
    expect(reverted.nextSegments[0]?.messages).toHaveLength(3);
  });

  it("appends a complete snapshot when append-only overflow chunks disappear", () => {
    const capabilities: CapabilityDescriptor = {
      ...deltaCapabilities,
      mutation: "append-only",
      streaming: "none",
      budgets: { ...deltaCapabilities.budgets, messageChars: 5 },
    };
    const first = planRender(
      projection("Hello world", { ended: true }),
      realization(),
      capabilities,
    );
    const firstSegments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: first.operations.map((operation, index) => ({
        messageId: operation.messageId,
        remoteRef: `remote-${index}`,
      })),
    });
    expect(firstSegments[0]?.messages).toHaveLength(3);

    const shrunk = planRender(
      projection("Hello", { lastSeq: 2, ended: true }),
      realization({ renderedThroughSeq: 1, segments: firstSegments, version: 1 }),
      capabilities,
    );
    expect(shrunk.operations).toEqual([
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:0:revision:3",
        content: expect.objectContaining({ text: "Hello" }),
      }),
    ]);
    expect(shrunk.nextSegments[0]?.activeMessageIds).toEqual([
      "run-1:segment:0:message:0:revision:3",
    ]);

    const applied = acknowledge(shrunk, {
      appliedOperationIds: shrunk.operations.map(({ id }) => id),
      messages: [{ messageId: shrunk.operations[0]!.messageId, remoteRef: "remote-snapshot" }],
    });
    const replay = planRender(
      projection("Hello", { lastSeq: 2, ended: true }),
      realization({ renderedThroughSeq: 2, segments: applied, version: 2 }),
      capabilities,
    );
    expect(replay.operations).toEqual([]);

    const regrown = planRender(
      projection("Hello world", { lastSeq: 3, ended: true }),
      realization({ renderedThroughSeq: 2, segments: applied, version: 2 }),
      capabilities,
    );
    expect(regrown.operations).toEqual([
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:1:revision:4",
      }),
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:2:revision:5",
      }),
    ]);
  });

  it("appends a complete snapshot when an earlier append-only chunk changes", () => {
    const capabilities: CapabilityDescriptor = {
      ...deltaCapabilities,
      mutation: "append-only",
      streaming: "none",
      budgets: { ...deltaCapabilities.budgets, messageChars: 5 },
    };
    const first = planRender(
      projection("Hello world", { ended: true }),
      realization(),
      capabilities,
    );
    const firstSegments = acknowledge(first, {
      appliedOperationIds: first.operations.map(({ id }) => id),
      messages: first.operations.map((operation, index) => ({
        messageId: operation.messageId,
        remoteRef: `remote-${index}`,
      })),
    });

    const changed = planRender(
      projection("Hallo world", { lastSeq: 2, ended: true }),
      realization({ renderedThroughSeq: 1, segments: firstSegments, version: 1 }),
      capabilities,
    );
    expect(changed.operations).toHaveLength(3);
    expect(changed.operations).toEqual([
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:0:revision:3",
        content: expect.objectContaining({ text: "Hallo" }),
      }),
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:1:revision:4",
        content: expect.objectContaining({ text: " worl" }),
      }),
      expect.objectContaining({
        type: "create",
        messageId: "run-1:segment:0:message:2:revision:5",
        content: expect.objectContaining({ text: "d" }),
      }),
    ]);
  });

  it("defers unfinished segments when the driver does not support streaming", () => {
    const capabilities: CapabilityDescriptor = {
      ...deltaCapabilities,
      streaming: "none",
    };
    const pending = planRender(projection("Hello", { lastSeq: 3 }), realization(), capabilities);
    expect(pending).toMatchObject({ toCursor: 0, operations: [] });

    const settled = planRender(
      projection("Hello", { lastSeq: 4, ended: true }),
      realization(),
      capabilities,
    );
    expect(settled.operations).toEqual([
      expect.objectContaining({ type: "create", finalized: true }),
    ]);
    expect(settled.toCursor).toBe(4);

    const settledSegments = acknowledge(settled, {
      appliedOperationIds: settled.operations.map(({ id }) => id),
      messages: [{ messageId: settled.operations[0]!.messageId, remoteRef: "remote-1" }],
    });
    const truncated = planRender(
      projection("Partial", { lastSeq: 2 }),
      realization({ renderedThroughSeq: 4, segments: settledSegments, version: 1 }),
      capabilities,
      { allowCursorRegression: true },
    );
    expect(truncated).toEqual({
      fromCursor: 4,
      toCursor: 2,
      operations: [],
      nextSegments: settledSegments,
    });
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
