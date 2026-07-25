import { describe, expect, it, vi } from "vitest";

import type { ToolCall, ToolDef, TranscriptMessage } from "#harness/core/index.js";
import { ThreadDispatchLock } from "#harness/dispatch/index.js";
import { runLoop } from "#harness/loop/index.js";
import { InMemoryEngine, InMemoryRunStore } from "#harness/memory/index.js";
import type { ToolExecutionOptions } from "#harness/ports/index.js";
import { createBlockingElicitation, InterruptManager, RunLifecycle } from "#harness/run/index.js";
import { FakeContextSession, FauxModelPort } from "#harness/testing/index.js";

const usage = {
  inputTokens: 2,
  outputTokens: 2,
  totalTokens: 4,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};
const requester = { principalId: "principal-1", displayName: "Nelson" };

describe("in-memory harness", () => {
  it("runs a gated tool through park, resolve, resume, and finish", async () => {
    const now = "2026-07-19T12:00:00.000Z";
    const store = new InMemoryRunStore({ now: () => now });
    const engine = new InMemoryEngine();
    const session = new FakeContextSession({
      sessionId: "session-1",
      mode: "delegated",
      scopeChain: [],
      standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
      tools: [],
      policySnapshot: {},
      snapshotHash: "snapshot-1",
    });
    const lifecycle = new RunLifecycle({
      store,
      engine,
      context: session,
      lock: new ThreadDispatchLock(),
      createId: () => "run-1",
      now: () => now,
    });
    const elicitation = createBlockingElicitation("elicit-1", {
      type: "approval_required",
      callId: "call-1",
      approvalId: "approval-1",
      reason: "Approve the deployment lookup?",
    });
    const call: ToolCall = {
      callId: "call-1",
      name: "deployments",
      input: { environment: "staging" },
      providerMeta: { providerCallId: "provider-call-1" },
    };
    const model = new FauxModelPort([
      {
        events: [elicitation],
        result: {
          message: {
            role: "assistant",
            blocks: [
              { type: "text", text: "I need approval to check deployments." },
              {
                type: "toolCall",
                callId: call.callId,
                name: call.name,
                input: call.input,
                providerMeta: call.providerMeta,
              },
            ],
          },
          toolCalls: [call],
          stopReason: "paused",
          usage,
        },
      },
      {
        events: [
          { type: "text-start", blockId: "text-2" },
          { type: "text-delta", blockId: "text-2", delta: "Deployment is healthy." },
          { type: "text-end", blockId: "text-2" },
        ],
        result: {
          message: {
            role: "assistant",
            blocks: [{ type: "text", text: "Deployment is healthy." }],
          },
          toolCalls: [],
          stopReason: "stop",
          usage,
        },
      },
    ]);
    const execute = vi.fn(
      async (approvedCall: ToolCall, _definition: ToolDef, _options?: ToolExecutionOptions) => ({
        callId: approvedCall.callId,
        status: "ok" as const,
        summary: "deployment is healthy",
        output: "deployment status: healthy",
      }),
    );
    const initial: TranscriptMessage[] = [
      { role: "user", blocks: [{ type: "text", text: "Check staging." }] },
    ];
    const loopInput = (abort: AbortSignal) => ({
      runId: "run-1",
      threadRef: "thread-1",
      model: { id: "test/model" },
      standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
      threadMessages: initial,
      tools: [
        {
          name: "deployments",
          title: "Deployments",
          description: "Read deployments",
          schema: {},
          kind: "connector" as const,
        },
      ],
      modelPort: model,
      store,
      toolExecutor: { execute },
      abort,
      elicitationExpiresAt: "2026-07-20T12:00:00.000Z",
    });

    const run = await lifecycle.create({
      threadRef: "thread-1",
      trigger: "message",
      sessionId: "session-1",
    });
    const paused = await lifecycle.execute(run.id, (abort) => runLoop(loopInput(abort)));
    expect(paused.status).toBe("paused");
    expect((await store.getRun(run.id))?.state).toBe("awaiting_approval");

    const resumeRequested = vi.fn(async () => undefined);
    const interrupts = new InterruptManager({
      store,
      context: session,
      now: () => now,
      isParticipant: () => true,
      enqueueResume: resumeRequested,
    });
    await interrupts.resolve({
      elicitationId: "elicit-1",
      optionId: "approve",
      decision: "approved",
      scope: "once",
      by: requester,
    });
    expect(resumeRequested).toHaveBeenCalledOnce();

    const finished = await lifecycle.execute(
      run.id,
      (abort) => runLoop(loopInput(abort)),
      undefined,
      "resume",
    );

    expect(finished).toMatchObject({ status: "finished", outcome: "completed", turns: 2 });
    expect((await store.getRun(run.id))?.state).toBe("completed");
    expect(execute).toHaveBeenCalledOnce();
    expect(execute.mock.calls[0]?.[0]).toMatchObject({
      callId: "call-1",
      providerMeta: { providerCallId: "provider-call-1" },
    });
    expect(execute.mock.calls[0]?.[2]).toEqual({ approvalId: "approval-1" });
    expect((await store.listTurns(run.id))[0]).toMatchObject({ stopReason: "toolUse" });
    expect((await store.listEvents(run.id)).map(({ event }) => event.type)).toEqual([
      "run-started",
      "elicitation",
      "segment-end",
      "elicitation-resolved",
      "run-started",
      "tool-result",
      "text-start",
      "text-delta",
      "text-end",
      "run-finished",
    ]);
    expect(session.calls.map(({ method }) => method)).toEqual(["resolveApproval", "close"]);
  });
});
