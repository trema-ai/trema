import type { Part, Projection } from "@trema/projection";
import {
  acknowledge,
  planRender,
  type RenderContent,
  type RenderOperation,
  type SurfaceApplyContext,
  type SurfaceRealization,
} from "@trema/surfaces";
import { describe, expect, it, vi } from "vitest";

import { SurfaceDriverError } from "#chat/index.js";
import { SlackDriver, type SlackDriverOptions, slackCapabilities } from "#chat/slack/index.js";

const context = {
  runId: "run-1",
  ref: {
    surface: "slack",
    locationRef: "T1:C1",
    threadRef: "1800000000.000001",
  },
  canonicalRunUrl: "https://trema.test/runs/run-1",
  realizationVersion: 1,
} as const satisfies SurfaceApplyContext;

const threadlessContext = {
  ...context,
  ref: { surface: "slack", locationRef: "T1:C1" },
} as const satisfies SurfaceApplyContext;

const canonicalRunLinkBlock = {
  type: "context",
  elements: [{ type: "mrkdwn", text: "<https://trema.test/runs/run-1|View full run>" }],
};

interface CapturedCall {
  body: Record<string, unknown>;
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
      body: JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>,
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
    minRequestIntervalMs: 0,
    ...options,
  });
}

function content(text: string, parts?: Part[]): RenderContent {
  return {
    text,
    parts: parts ?? [{ kind: "text", id: "text-1", status: "streaming", markdown: text }],
  };
}

function create(
  text: string,
  options: { finalized?: boolean; parts?: Part[]; id?: string } = {},
): Extract<RenderOperation, { type: "create" }> {
  return {
    id: options.id ?? "run-1:segment:0:message:0:create",
    type: "create",
    messageId: "run-1:segment:0:message:0",
    segmentId: "run-1:segment:0",
    segmentIndex: 0,
    messageIndex: 0,
    content: content(text, options.parts),
    finalized: options.finalized ?? false,
  };
}

function mutation(
  type: "append" | "delete" | "finalize" | "replace",
  options: {
    text?: string;
    parts?: Part[];
    prior?: { text: string; metadata?: Record<string, unknown> };
  } = {},
): RenderOperation {
  const base = {
    id: `run-1:segment:0:message:0:${type}:1:hash`,
    messageId: "run-1:segment:0:message:0",
    segmentId: "run-1:segment:0",
    segmentIndex: 0,
    messageIndex: 0,
    remoteRef: "1800000001.000001",
  };
  const prior = options.prior ?? { text: "Starting" };
  if (type === "append") return { ...base, type, text: options.text ?? " more", prior };
  if (type === "delete") return { ...base, type };
  return {
    ...base,
    type,
    content: content(options.text ?? "Complete", options.parts),
    prior,
  };
}

function pendingElicitation(): Extract<Part, { kind: "elicitation" }> {
  return {
    kind: "elicitation",
    id: "elicitation-part-1",
    elicitationId: "approval-1",
    elicitationKind: "approval",
    prompt: "**Deploy** version 2.4.1?",
    options: [
      { id: "approve", label: "Approve", style: "primary" },
      { id: "deny", label: "Deny", style: "danger" },
    ],
    blocking: true,
  };
}

describe("SlackDriver", () => {
  it("starts a threaded stream from committed render content and returns its durable ref", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);
    const result = await driver({
      fetch: slack.fetch,
      recipient: { teamRef: "T1", userRef: "U1" },
    }).apply([create("Starting")], context);

    expect(result).toMatchObject({
      appliedOperationIds: ["run-1:segment:0:message:0:create"],
      messages: [
        {
          messageId: "run-1:segment:0:message:0",
          remoteRef: "1800000001.000001",
          metadata: expect.objectContaining({
            clientMessageId: expect.stringMatching(/^[0-9a-f-]{36}$/),
            mode: "stream",
          }),
        },
      ],
    });
    expect(slack.calls).toEqual([
      {
        method: "chat.startStream",
        contentType: "application/json",
        body: {
          channel: "C1",
          chunks: [{ type: "markdown_text", text: "Starting" }],
          client_msg_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
          recipient_team_id: "T1",
          recipient_user_id: "U1",
          task_display_mode: "plan",
          thread_ts: "1800000000.000001",
        },
      },
    ]);
  });

  it("preserves stream mode across lifecycle-only transitions", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const realization: SurfaceRealization = {
      id: "realization-1",
      orgId: "org-1",
      runId: "run-1",
      ref: context.ref,
      renderedThroughSeq: 0,
      segments: [],
      presentation: {},
      reconciliationRequired: false,
      nativeStopPending: false,
      version: 0,
      retry: { attempt: 0, terminal: false },
    };
    const projection = (
      status: Projection["status"],
      lastSeq: number,
      parts: Part[] = [],
    ): Projection => ({
      runId: "run-1",
      status,
      segments: parts.length === 0 ? [] : [{ index: 0, parts }],
      unknownEvents: 0,
      lastSeq,
    });

    const queuedPlan = planRender(projection("pending", 0), realization, slackCapabilities);
    const queued = await render.apply(queuedPlan.operations, context);
    const runningPlan = planRender(
      projection("running", 1),
      { ...realization, segments: acknowledge(queuedPlan, queued) },
      slackCapabilities,
    );
    const running = await render.apply(runningPlan.operations, context);
    const answerPlan = planRender(
      projection("running", 2, [
        { kind: "text", id: "text-1", status: "streaming", markdown: "Answer" },
      ]),
      {
        ...realization,
        renderedThroughSeq: 1,
        segments: acknowledge(runningPlan, running),
      },
      slackCapabilities,
    );
    const appended = await render.apply(answerPlan.operations, context);

    expect(slack.calls.map(({ method }) => method)).toEqual([
      "chat.startStream",
      "chat.appendStream",
      "chat.appendStream",
    ]);
    expect(slack.calls[0]?.body.chunks).toEqual([
      { type: "plan_update", title: "Progress" },
      expect.objectContaining({ type: "task_update", title: "Run queued", status: "pending" }),
    ]);
    expect(slack.calls[1]?.body.chunks).toEqual([
      expect.objectContaining({ type: "task_update", title: "Run active", status: "in_progress" }),
    ]);
    expect(slack.calls[2]?.body.chunks).toEqual([{ type: "markdown_text", text: "Answer" }]);
    expect(running.messages[0]).toMatchObject({ metadata: { mode: "stream" } });
    expect(appended.messages[0]).toMatchObject({ metadata: { mode: "stream" } });
  });

  it("keeps threadless in-progress deliveries in editable snapshot mode", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });

    const started = await render.apply([create("Starting")], threadlessContext);
    const startedMetadata = started.messages[0]?.metadata;
    const grown = await render.apply(
      [
        mutation("append", {
          text: " more",
          prior: {
            text: "Starting",
            ...(startedMetadata === undefined ? {} : { metadata: startedMetadata }),
          },
        }),
      ],
      threadlessContext,
    );
    const grownMetadata = grown.messages[0]?.metadata;
    await render.apply(
      [
        mutation("finalize", {
          text: "Complete",
          prior: {
            text: "Starting more",
            ...(grownMetadata === undefined ? {} : { metadata: grownMetadata }),
          },
        }),
      ],
      threadlessContext,
    );

    expect(started.messages[0]).toMatchObject({
      remoteRef: "1800000001.000001",
      metadata: { mode: "snapshot" },
    });
    expect(grown.messages[0]).toMatchObject({ metadata: { mode: "snapshot" } });
    expect(slack.calls.map(({ method }) => method)).toEqual([
      "chat.postMessage",
      "chat.update",
      "chat.update",
    ]);
    expect(slack.calls[0]?.body).not.toHaveProperty("thread_ts");
    expect(slack.calls[0]?.body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Starting" } },
      canonicalRunLinkBlock,
    ]);
    expect(slack.calls[1]?.body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Starting more" } },
      canonicalRunLinkBlock,
    ]);
    expect(slack.calls[2]?.body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Complete" } },
      canonicalRunLinkBlock,
    ]);
  });

  it("streams safe reasoning, tool progress, and citations as native Thinking Steps", async () => {
    const parts: Part[] = [
      {
        kind: "reasoning",
        id: "reason-1",
        status: "streaming",
        text: "Check the deployment state",
      },
      {
        kind: "reasoning",
        id: "reason-secret",
        status: "done",
        text: "private chain of thought",
        redacted: true,
      },
      {
        kind: "activity",
        id: "call-1",
        status: "streaming",
        callId: "call-1",
        name: "deploy_status",
        title: "Checking deployment",
        toolKind: "other",
        input: "super-secret tool input",
        notes: ["Reading [deploy docs](https://example.com/deploy)"],
      },
      {
        kind: "text",
        id: "text-1",
        status: "streaming",
        markdown: "I’ll report back with the [runbook](https://example.com/runbook).",
      },
    ];
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);

    await driver({ fetch: slack.fetch }).apply([create("fallback", { parts })], context);

    const call = slack.calls[0];
    expect(call?.body.task_display_mode).toBe("plan");
    expect(call?.body).not.toHaveProperty("markdown_text");
    expect(call?.body.chunks).toEqual([
      { type: "plan_update", title: "Progress" },
      expect.objectContaining({
        type: "task_update",
        id: expect.stringMatching(/^task_[0-9a-f]{32}$/),
        title: "Thinking",
        status: "in_progress",
      }),
      expect.objectContaining({
        type: "task_update",
        id: expect.stringMatching(/^task_[0-9a-f]{32}$/),
        title: "Thinking",
        status: "complete",
      }),
      expect.objectContaining({
        type: "task_update",
        id: expect.stringMatching(/^task_[0-9a-f]{32}$/),
        title: "Checking deployment",
        status: "in_progress",
      }),
      expect.objectContaining({
        type: "task_update",
        title: "Sources",
        status: "complete",
        sources: [{ type: "url", text: "runbook", url: "https://example.com/runbook" }],
      }),
      {
        type: "markdown_text",
        text: "I’ll report back with the [runbook](https://example.com/runbook).",
      },
    ]);
    expect(JSON.stringify(call?.body)).not.toContain("private chain of thought");
    expect(JSON.stringify(call?.body)).not.toContain("Check the deployment state");
    expect(JSON.stringify(call?.body)).not.toContain("super-secret tool input");
    expect(JSON.stringify(call?.body)).not.toContain("Reading deploy docs");
  });

  it("reconciles approval tasks from committed state with stable ids and actor attribution", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const pending = pendingElicitation();
    const started = await render.apply(
      [
        create("Waiting for approval", {
          finalized: true,
          parts: [pending],
        }),
      ],
      context,
    );
    const metadata = started.messages[0]?.metadata;
    const resolved: Part = {
      ...pending,
      resolution: {
        optionId: "approve",
        by: { principalId: "principal-1", displayName: "Ada" },
        at: "2026-08-04T00:00:00.000Z",
      },
    };

    await render.apply(
      [
        mutation("finalize", {
          text: "Approved",
          parts: [resolved],
          prior: {
            text: "Waiting for approval",
            ...(metadata === undefined ? {} : { metadata }),
          },
        }),
      ],
      context,
    );

    const initialBlocks = slack.calls[0]?.body.blocks as Array<Record<string, unknown>>;
    const initialPlan = initialBlocks[0];
    const initialTasks = initialPlan?.tasks as Array<Record<string, unknown>>;
    const updateBlocks = slack.calls[1]?.body.blocks as Array<Record<string, unknown>>;
    const updatePlan = updateBlocks[0];
    const updateTasks = updatePlan?.tasks as Array<Record<string, unknown>>;
    const pendingTask = initialTasks.find(({ title }) => title === "Approval required");
    const resolvedTask = updateTasks.find(({ title }) => title === "Approval resolved");
    expect(slack.calls.map(({ method }) => method)).toEqual(["chat.postMessage", "chat.update"]);
    expect(slack.calls[0]?.body.text).toBe("*Deploy* version 2.4.1?");
    expect(JSON.stringify(slack.calls[0]?.body)).toContain('"type":"actions"');
    expect(resolvedTask).toMatchObject({
      task_id: pendingTask?.task_id,
      status: "complete",
    });
    expect(JSON.stringify(resolvedTask?.output)).toContain("Approve by Ada");
    expect(JSON.stringify(slack.calls[1]?.body)).not.toContain('"type":"actions"');
  });

  it("keeps sensitive progress detail out of snapshot bodies and fallback text", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const sensitiveParts: Part[] = [
      {
        kind: "reasoning",
        id: "reason-1",
        status: "done",
        text: "private reasoning detail",
      },
      {
        kind: "activity",
        id: "call-1",
        status: "done",
        callId: "call-1",
        name: "lookup",
        title: "Looking up deployment",
        toolKind: "other",
        input: "secret tool input",
        notes: ["secret tool note"],
        result: { status: "ok", summary: "secret tool result" },
      },
      { kind: "text", id: "text-1", status: "done", markdown: "Visible answer" },
    ];

    await render.apply(
      [
        create("private reasoning detail\nsecret tool note\nsecret tool result\nVisible answer", {
          finalized: true,
          parts: sensitiveParts,
        }),
        mutation("replace", {
          text: "private reasoning detail\nsecret tool note\nsecret tool result\nVisible answer",
          parts: sensitiveParts,
          prior: { text: "Original", metadata: { mode: "snapshot" } },
        }),
      ],
      context,
    );

    expect(slack.calls.map(({ method }) => method)).toEqual(["chat.postMessage", "chat.update"]);
    for (const call of slack.calls) {
      expect(call.body.text).toBe("Visible answer");
      expect(JSON.stringify(call.body)).not.toContain("private reasoning detail");
      expect(JSON.stringify(call.body)).not.toContain("secret tool input");
      expect(JSON.stringify(call.body)).not.toContain("secret tool note");
      expect(JSON.stringify(call.body)).not.toContain("secret tool result");
    }
  });

  it("omits sensitive activity continuations that have no typed source part", async () => {
    const sensitiveNote = "secret tool note ".repeat(1_000);
    const projection: Projection = {
      runId: "run-1",
      status: "completed",
      segments: [
        {
          index: 0,
          parts: [
            {
              kind: "activity",
              id: "call-1",
              status: "done",
              callId: "call-1",
              name: "lookup",
              title: "Looking up deployment",
              toolKind: "other",
              notes: [sensitiveNote],
              result: { status: "ok", summary: "secret tool result" },
            },
          ],
        },
      ],
      unknownEvents: 0,
      lastSeq: 1,
    };
    const realization: SurfaceRealization = {
      id: "realization-1",
      orgId: "org-1",
      runId: "run-1",
      ref: context.ref,
      renderedThroughSeq: 0,
      segments: [],
      presentation: {},
      reconciliationRequired: false,
      nativeStopPending: false,
      version: 0,
      retry: { attempt: 0, terminal: false },
    };
    const plan = planRender(projection, realization, slackCapabilities);
    const continuation = plan.operations[1];
    expect(continuation).toMatchObject({
      type: "create",
      content: { parts: [], text: expect.stringContaining("secret tool note") },
    });
    const slack = fakeSlack(
      plan.operations.map(() => ({
        body: { ok: true, channel: "C1", ts: "1800000001.000001" },
      })),
    );

    await driver({ fetch: slack.fetch }).apply(plan.operations, context);

    expect(slack.calls).toHaveLength(2);
    expect(slack.calls.map(({ method }) => method)).toEqual([
      "chat.postMessage",
      "chat.postMessage",
    ]);
    for (const call of slack.calls) {
      expect(JSON.stringify(call.body)).not.toContain("secret tool note");
      expect(JSON.stringify(call.body)).not.toContain("secret tool result");
    }
  });

  it("replaces an untyped activity continuation instead of appending its raw delta", async () => {
    const initialNote = "x".repeat(slackCapabilities.budgets.messageChars * 2);
    const activityProjection = (note: string, lastSeq: number): Projection => ({
      runId: "run-1",
      status: "running",
      segments: [
        {
          index: 0,
          parts: [
            {
              kind: "activity",
              id: "call-1",
              status: "streaming",
              callId: "call-1",
              name: "lookup",
              title: "Looking up deployment",
              toolKind: "other",
              notes: [note],
            },
          ],
        },
      ],
      unknownEvents: 0,
      lastSeq,
    });
    const realization: SurfaceRealization = {
      id: "realization-1",
      orgId: "org-1",
      runId: "run-1",
      ref: context.ref,
      renderedThroughSeq: 0,
      segments: [],
      presentation: {},
      reconciliationRequired: false,
      nativeStopPending: false,
      version: 0,
      retry: { attempt: 0, terminal: false },
    };
    const initialPlan = planRender(
      activityProjection(initialNote, 1),
      realization,
      slackCapabilities,
    );
    const slack = fakeSlack(
      [...initialPlan.operations, {}, {}].map(() => ({
        body: { ok: true, channel: "C1", ts: "1800000001.000001" },
      })),
    );
    const render = driver({ fetch: slack.fetch });
    const initialResult = await render.apply(initialPlan.operations, context);
    const appendedSecret = "LIVE_SECRET_DELTA";
    const incrementalPlan = planRender(
      activityProjection(`${initialNote}${appendedSecret}`, 2),
      {
        ...realization,
        renderedThroughSeq: 1,
        segments: acknowledge(initialPlan, initialResult),
      },
      slackCapabilities,
    );

    expect(incrementalPlan.operations.find(({ messageIndex }) => messageIndex === 2)).toMatchObject(
      {
        type: "replace",
        content: { parts: [], text: expect.stringContaining(appendedSecret) },
      },
    );

    const initialCallCount = slack.calls.length;
    await render.apply(incrementalPlan.operations, context);

    expect(slack.calls).toHaveLength(initialCallCount);
    expect(JSON.stringify(slack.calls)).not.toContain(appendedSecret);
  });

  it("uses only safe narrative when finalizing a reconciled stream", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const started = await render.apply(
      [
        create("Visible draft", {
          parts: [{ kind: "text", id: "text-1", status: "streaming", markdown: "Visible draft" }],
        }),
      ],
      context,
    );
    const metadata = started.messages[0]?.metadata;

    await render.apply(
      [
        mutation("finalize", {
          text: "private reasoning detail\nsecret tool note\nsecret tool result\nVisible final",
          parts: [
            {
              kind: "reasoning",
              id: "reason-1",
              status: "done",
              text: "private reasoning detail",
            },
            {
              kind: "activity",
              id: "call-1",
              status: "done",
              callId: "call-1",
              name: "lookup",
              title: "Looking up deployment",
              toolKind: "other",
              notes: ["secret tool note"],
              result: { status: "ok", summary: "secret tool result" },
            },
            { kind: "text", id: "text-1", status: "done", markdown: "Visible final" },
          ],
          prior: {
            text: "Visible draft",
            ...(metadata === undefined ? {} : { metadata }),
          },
        }),
      ],
      context,
    );

    expect(slack.calls[1]).toMatchObject({
      method: "chat.stopStream",
      body: { markdown_text: "Visible final" },
    });
    expect(JSON.stringify(slack.calls[1]?.body)).not.toContain("private reasoning detail");
    expect(JSON.stringify(slack.calls[1]?.body)).not.toContain("secret tool note");
    expect(JSON.stringify(slack.calls[1]?.body)).not.toContain("secret tool result");
  });

  it("rate-limits advisory assistant presence in a thread", async () => {
    const slack = fakeSlack([{ body: { ok: true } }]);

    await driver({ fetch: slack.fetch }).presence("working", context);

    expect(slack.calls).toEqual([
      {
        method: "assistant.threads.setStatus",
        contentType: "application/json",
        body: {
          channel_id: "C1",
          thread_ts: "1800000000.000001",
          status: "Working…",
        },
      },
    ]);
  });

  it("bounds native Thinking Step titles and omits unclassified detail", async () => {
    const longText = "x".repeat(400);
    const parts: Part[] = [
      { kind: "reasoning", id: "reason-1", status: "done", text: longText },
      {
        kind: "activity",
        id: "call-1",
        status: "done",
        callId: "call-1",
        name: "long_task",
        title: longText,
        toolKind: "other",
        notes: [longText],
      },
    ];
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);

    await driver({ fetch: slack.fetch }).apply([create("fallback", { parts })], context);

    const chunks = slack.calls[0]?.body.chunks as Array<Record<string, unknown>>;
    const tasks = chunks.filter(({ type }) => type === "task_update");
    expect(tasks).toHaveLength(2);
    expect(
      tasks.every(({ title }) => typeof title === "string" && Array.from(title).length <= 256),
    ).toBe(true);
    expect(tasks.every((task) => !("output" in task))).toBe(true);
  });

  it("reconciles a task card by stable id without exposing result detail", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const running: Part = {
      kind: "activity",
      id: "call-1",
      status: "streaming",
      callId: "call-1",
      name: "search",
      title: "Searching",
      toolKind: "other",
      notes: [],
    };
    const started = await render.apply([create("Searching", { parts: [running] })], context);
    const metadata = started.messages[0]?.metadata;
    const finished: Part = {
      ...running,
      status: "done",
      notes: ["Found [Slack docs](https://docs.slack.dev/)"],
      result: { status: "ok", summary: "Ready" },
    };

    await render.apply(
      [
        mutation("replace", {
          text: "Searching\nFound Slack docs\nReady",
          parts: [finished],
          prior: { text: "Searching", ...(metadata === undefined ? {} : { metadata }) },
        }),
      ],
      context,
    );

    const initialTask = (
      slack.calls[0]?.body.chunks as Array<Record<string, unknown>> | undefined
    )?.find(({ type }) => type === "task_update");
    const updatedTask = (
      slack.calls[1]?.body.chunks as Array<Record<string, unknown>> | undefined
    )?.find(({ type }) => type === "task_update");
    expect(slack.calls[1]?.method).toBe("chat.appendStream");
    expect(updatedTask).toMatchObject({
      id: initialTask?.id,
      title: "Searching",
      status: "complete",
    });
    expect(updatedTask).not.toHaveProperty("output");
    expect(updatedTask).not.toHaveProperty("sources");
    expect(updatedTask).not.toHaveProperty("details");
  });

  it("finalizes the stream with only the durable Thinking Steps delta", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const running: Part = {
      kind: "activity",
      id: "call-1",
      status: "streaming",
      callId: "call-1",
      name: "build",
      title: "Building",
      toolKind: "other",
      notes: [],
    };
    const initialParts: Part[] = [
      running,
      { kind: "text", id: "text-1", status: "streaming", markdown: "Draft" },
    ];
    const started = await render.apply([create("Draft", { parts: initialParts })], context);
    const metadata = started.messages[0]?.metadata;
    const finalParts: Part[] = [
      {
        ...running,
        status: "done",
        result: { status: "ok", summary: "Build passed" },
      },
      { kind: "text", id: "text-1", status: "done", markdown: "Draft complete" },
    ];

    await render.apply(
      [
        mutation("finalize", {
          text: "Draft complete",
          parts: finalParts,
          prior: { text: "Draft", ...(metadata === undefined ? {} : { metadata }) },
        }),
      ],
      context,
    );

    expect(slack.calls[1]).toMatchObject({
      method: "chat.stopStream",
      body: {
        blocks: [canonicalRunLinkBlock],
        chunks: [
          expect.objectContaining({
            type: "task_update",
            title: "Building",
            status: "complete",
          }),
          { type: "markdown_text", text: " complete" },
        ],
      },
    });
    expect(slack.calls[1]?.body).not.toHaveProperty("markdown_text");
  });

  it("attaches resolvable controls when a stream pauses for an elicitation", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const render = driver({ fetch: slack.fetch });
    const started = await render.apply(
      [
        create("Working", {
          parts: [{ kind: "text", id: "text-1", status: "streaming", markdown: "Working" }],
        }),
      ],
      context,
    );
    const metadata = started.messages[0]?.metadata;

    await render.apply(
      [
        mutation("finalize", {
          text: "Working\n\nDeploy version 2.4.1?\n1. Approve\n2. Deny",
          parts: [
            { kind: "text", id: "text-1", status: "done", markdown: "Working" },
            pendingElicitation(),
          ],
          prior: { text: "Working", ...(metadata === undefined ? {} : { metadata }) },
        }),
      ],
      context,
    );

    expect(slack.calls[1]).toMatchObject({
      method: "chat.stopStream",
      body: {
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "*Deploy* version 2.4.1?" } },
          {
            type: "actions",
            elements: [
              expect.objectContaining({
                action_id: "input:approval-1:button:0",
                type: "button",
                value: "approve",
              }),
              expect.objectContaining({
                action_id: "input:approval-1:button:1",
                type: "button",
                value: "deny",
              }),
            ],
          },
          canonicalRunLinkBlock,
        ],
      },
    });
  });

  it("appends and finalizes the same Slack stream", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const operations = [
      mutation("append", { prior: { text: "Starting", metadata: { mode: "stream" } } }),
      mutation("finalize", { prior: { text: "Starting", metadata: { mode: "stream" } } }),
    ];
    const result = await driver({ fetch: slack.fetch }).apply(operations, context);

    expect(result.appliedOperationIds).toEqual(operations.map(({ id }) => id));
    expect(result.messages).toEqual([
      expect.objectContaining({
        remoteRef: "1800000001.000001",
        metadata: expect.objectContaining({ mode: "stream" }),
      }),
      expect.objectContaining({
        remoteRef: "1800000001.000001",
        metadata: expect.objectContaining({ mode: "final" }),
      }),
    ]);
    expect(slack.calls.map(({ method }) => method)).toEqual([
      "chat.appendStream",
      "chat.stopStream",
    ]);
    expect(slack.calls[0]?.body).toMatchObject({
      chunks: [{ type: "markdown_text", text: " more" }],
    });
    expect(slack.calls[1]?.body).toMatchObject({
      blocks: [canonicalRunLinkBlock],
      markdown_text: "Complete",
    });
  });

  it("updates messages when prior Slack mode is absent or unrecognized", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);

    const result = await driver({ fetch: slack.fetch }).apply(
      [
        mutation("append", {
          text: " more",
          prior: { text: "Starting", metadata: { mode: "legacy" } },
        }),
        mutation("finalize", { prior: { text: "Starting more" } }),
      ],
      context,
    );

    expect(slack.calls.map(({ method }) => method)).toEqual(["chat.update", "chat.update"]);
    expect(slack.calls[0]?.body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Starting more" } },
      canonicalRunLinkBlock,
    ]);
    expect(slack.calls[1]?.body.blocks).toEqual([
      { type: "section", text: { type: "mrkdwn", text: "Complete" } },
      canonicalRunLinkBlock,
    ]);
    expect(result.messages).toEqual([
      expect.objectContaining({ metadata: expect.objectContaining({ mode: "snapshot" }) }),
      expect.objectContaining({ metadata: expect.objectContaining({ mode: "final" }) }),
    ]);
  });

  it("keeps the canonical run link on snapshot replacements", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);

    await driver({ fetch: slack.fetch }).apply(
      [
        mutation("replace", {
          text: "Corrected",
          prior: { text: "Original", metadata: { mode: "snapshot" } },
        }),
      ],
      context,
    );

    expect(slack.calls[0]).toMatchObject({
      method: "chat.update",
      body: {
        blocks: [
          { type: "section", text: { type: "mrkdwn", text: "Corrected" } },
          canonicalRunLinkBlock,
        ],
      },
    });
  });

  it("renders text, code, tools, citations, and errors into bounded Block Kit", async () => {
    const markdown = [
      "## Result",
      "**Ready** for @U2. See [source](https://example.com/report?q=1&ok=1).",
      "```ts",
      "const owner = '@U3'",
      "```",
      "Deploying",
      "deployment is healthy",
      "Error: transient blip",
    ].join("\n");
    const parts: Part[] = [
      { kind: "text", id: "text-1", status: "done", markdown },
      {
        kind: "activity",
        id: "call-1",
        status: "done",
        callId: "call-1",
        name: "deploy",
        title: "Deploying",
        toolKind: "other",
        notes: [],
        result: { status: "ok", summary: "deployment is healthy" },
      },
      { kind: "error", id: "error-1", message: "transient blip", recoverable: true },
    ];
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);

    await driver({ fetch: slack.fetch }).apply(
      [create(markdown, { finalized: true, parts })],
      context,
    );

    const call = slack.calls[0];
    expect(call?.method).toBe("chat.postMessage");
    expect(call?.body.text).toContain("*Result*");
    expect(call?.body.text).toContain("*Ready* for <@U2>");
    expect(call?.body.text).toContain("<https://example.com/report?q=1&amp;ok=1|source>");
    expect(call?.body.text).toContain("const owner = '@U3'");
    expect(call?.body.text).toContain("Error: transient blip");
    const blocks = call?.body.blocks as Array<Record<string, unknown>>;
    expect(blocks[0]).toMatchObject({
      type: "plan",
      tasks: expect.arrayContaining([
        expect.objectContaining({ title: "Deploying", status: "complete" }),
        expect.objectContaining({ title: "Sources", status: "complete" }),
      ]),
    });
    const sections = blocks.filter((block) => block.type === "section") as Array<{
      text: { text: string };
    }>;
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((block) => Array.from(block.text.text).length <= 3_000)).toBe(true);
    expect(blocks.at(-1)).toEqual(canonicalRunLinkBlock);
  });

  it("renders elicitation controls when the first delivery is already final", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);

    await driver({ fetch: slack.fetch }).apply(
      [
        create("Deploy version 2.4.1?\n1. Approve\n2. Deny", {
          finalized: true,
          parts: [pendingElicitation()],
        }),
      ],
      context,
    );

    expect(slack.calls[0]).toMatchObject({
      method: "chat.postMessage",
      body: {
        blocks: [
          expect.objectContaining({ type: "plan" }),
          { type: "section", text: { type: "mrkdwn", text: "*Deploy* version 2.4.1?" } },
          { type: "actions", elements: expect.arrayContaining([expect.any(Object)]) },
          canonicalRunLinkBlock,
        ],
      },
    });
  });

  it("preserves elicitation choices across Slack action blocks", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);
    const options = Array.from({ length: 26 }, (_, index) => ({
      id: `choice-${index + 1}`,
      label: `Choice ${index + 1}`,
    }));
    const elicitation: Extract<Part, { kind: "elicitation" }> = {
      ...pendingElicitation(),
      options,
    };

    await driver({ fetch: slack.fetch }).apply(
      [create("Choose an option", { finalized: true, parts: [elicitation] })],
      context,
    );

    const blocks = slack.calls[0]?.body.blocks as Array<Record<string, unknown>>;
    const actions = blocks.filter(({ type }) => type === "actions") as Array<{
      elements: Array<{ value: string }>;
    }>;
    expect(actions.map(({ elements }) => elements)).toHaveLength(2);
    expect(actions.map(({ elements }) => elements.length)).toEqual([25, 1]);
    expect(actions.flatMap(({ elements }) => elements.map(({ value }) => value))).toEqual(
      options.map(({ id }) => id),
    );
    expect(blocks.at(-1)).toEqual(canonicalRunLinkBlock);
  });

  it("degrades a maximum-sized answer into deterministic Slack sections", async () => {
    const slack = fakeSlack([{ body: { ok: true, channel: "C1", ts: "1800000001.000001" } }]);
    await driver({ fetch: slack.fetch }).apply(
      [create(`\`\`\`\n${"x".repeat(11_492)}\n\`\`\``, { finalized: true })],
      context,
    );

    const blocks = slack.calls[0]?.body.blocks as Array<Record<string, unknown>>;
    const sections = blocks.filter((block) => block.type === "section") as Array<{
      text: { text: string };
    }>;
    expect(blocks).toHaveLength(5);
    expect(sections).toHaveLength(4);
    expect(sections.every((block) => Array.from(block.text.text).length <= 3_000)).toBe(true);
    expect(blocks.at(-1)).toEqual(canonicalRunLinkBlock);
    expect(
      sections
        .map((block) => block.text.text)
        .join("")
        .replaceAll(/[^x]/gu, ""),
    ).toHaveLength(11_492);
  });

  it("reuses the same Slack idempotency key when a staged create is replayed", async () => {
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);
    const operation = create("Recovered", { id: "stable-create-operation" });
    const render = driver({ fetch: slack.fetch });

    const first = await render.apply([operation], context);
    const replay = await render.apply([operation], { ...context, realizationVersion: 3 });

    expect(slack.calls[0]?.body.client_msg_id).toBe(slack.calls[1]?.body.client_msg_id);
    expect(replay.messages[0]?.remoteRef).toBe(first.messages[0]?.remoteRef);
  });

  it("serializes Slack mutations behind the configured flush interval", async () => {
    let now = 0;
    const sleep = vi.fn(async (milliseconds: number) => {
      now += milliseconds;
    });
    const slack = fakeSlack([
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
      { body: { ok: true, channel: "C1", ts: "1800000001.000001" } },
    ]);

    await driver({
      fetch: slack.fetch,
      minRequestIntervalMs: 600,
      now: () => now,
      sleep,
    }).apply([mutation("append"), mutation("finalize")], context);

    expect(sleep).toHaveBeenCalledOnce();
    expect(sleep).toHaveBeenCalledWith(600);
  });

  it("treats a missing message as an already-converged replayed delete", async () => {
    const slack = fakeSlack([{ body: { ok: false, error: "message_not_found" } }]);
    await expect(
      driver({ fetch: slack.fetch }).apply([mutation("delete")], context),
    ).resolves.toEqual(
      expect.objectContaining({ appliedOperationIds: [expect.stringContaining(":delete:")] }),
    );
  });

  it("acknowledges a replay when Slack already finalized the stream", async () => {
    const slack = fakeSlack([{ body: { ok: false, error: "message_not_in_streaming_state" } }]);

    await expect(
      driver({ fetch: slack.fetch }).apply(
        [mutation("finalize", { prior: { text: "Starting", metadata: { mode: "stream" } } })],
        context,
      ),
    ).resolves.toMatchObject({
      appliedOperationIds: [expect.stringContaining(":finalize:")],
      messages: [expect.objectContaining({ metadata: expect.objectContaining({ mode: "final" }) })],
    });
  });

  it("does not acknowledge a finalize when Slack cannot find the message", async () => {
    const slack = fakeSlack([{ body: { ok: false, error: "message_not_found" } }]);
    const error = await driver({ fetch: slack.fetch })
      .apply([mutation("finalize")], context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({ code: "message_not_found", retryable: false });
  });

  it("preserves Slack retry-after as a retryable surface error", async () => {
    const slack = fakeSlack([
      {
        body: { ok: false, error: "ratelimited" },
        status: 429,
        headers: { "retry-after": "7" },
      },
    ]);
    const error = await driver({ fetch: slack.fetch })
      .apply([create("Hello", { finalized: true })], context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({ code: "rate_limited", retryable: true, retryAfterMs: 7_000 });
  });

  it.each([
    ["token_revoked", "revoked"],
    ["invalid_auth", "unauthorized"],
    ["message_not_found", "message_not_found"],
    ["stopped_by_user", "stopped_by_user"],
    ["channel_not_found", "destination_not_found"],
    ["invalid_blocks", "invalid_request"],
    ["service_unavailable", "unavailable"],
  ] as const)("classifies Slack error %s as %s", async (slackError, code) => {
    const slack = fakeSlack([{ body: { ok: false, error: slackError } }]);
    const error = await driver({ fetch: slack.fetch })
      .apply([create("Hello", { finalized: true })], context)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(SurfaceDriverError);
    expect(error).toMatchObject({ code });
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
});
