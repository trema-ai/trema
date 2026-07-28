import type {
  ModelRef,
  StopReason,
  ToolCall,
  ToolDef,
  TranscriptMessage,
  Usage,
} from "#harness/core/index.js";
import type { RunEventData } from "#harness/events/index.js";
import type {
  HarnessHooks,
  ModelPort,
  RunStore,
  SessionStanding,
  ThinkingLevel,
  ToolExecutionResult,
  ToolExecutor,
  TurnRecord,
  TurnResult,
} from "#harness/ports/index.js";
import { executeToolBatch, toToolResultEvent, toToolResultMessage } from "./tool-batch.js";

/** Dependencies and durable context for one loop execution. */
export interface LoopInput {
  runId: string;
  threadRef: string;
  model: ModelRef;
  standing: SessionStanding;
  threadMessages: TranscriptMessage[];
  tools: ToolDef[];
  modelPort: ModelPort;
  store: RunStore;
  toolExecutor: ToolExecutor;
  abort: AbortSignal;
  thinking?: ThinkingLevel;
  /** Maximum generated tokens for each model turn. */
  budget?: { maxOutputTokens?: number };
  /** Hard cap on turns per run; the shouldStop hook can only stop earlier. */
  maxTurns?: number;
  /** Expiry stored with a blocking elicitation created during this execution. */
  elicitationExpiresAt?: string;
  hooks?: HarnessHooks;
}

/**
 * Default hard cap on turns per run.
 * @defaultValue 50
 */
export const DEFAULT_MAX_TURNS = 50;

/** Terminal loop result for a completed, failed, or cancelled run. */
export interface FinishedLoopResult {
  status: "finished";
  outcome: "completed" | "failed" | "cancelled";
  stopReason: StopReason;
  turns: number;
  usage: Usage;
  error?: TurnResult["error"];
}

/**
 * Result from a turn that committed a blocking elicitation.
 * Execution has ended; resume requires a new `runLoop` call that reads the stored turn.
 */
export interface PausedLoopResult {
  status: "paused";
  stopReason: "paused";
  turn: number;
  elicitation: Extract<RunEventData, { type: "elicitation" }>;
  usage: Usage;
}

/** Terminal or paused result from one loop execution. */
export type LoopResult = FinishedLoopResult | PausedLoopResult;

/**
 * Executes model turns from committed state and checkpoints each turn in the run store.
 * Model, tool, and hook failures become run data after streaming starts.
 */
export async function runLoop(input: LoopInput): Promise<LoopResult> {
  const committed = await input.store.listTurns(input.runId);
  const messages = assembleCommittedMessages(input.threadMessages, committed);
  await resumePendingTurn(input, committed, messages);
  const instructions = assembleInstructions(input.standing);
  let usage = sumUsage(committed.map(({ usage: turnUsage }) => turnUsage));
  let turn = committed.length;
  let lastStopReason: StopReason = "stop";
  // Input drained for the turn being built. It is committed with that turn,
  // which is what lets a later execution replay it (see `TurnRecord.input`).
  let turnInput: TranscriptMessage[] = [];

  while (true) {
    while (true) {
      const eventCursor = await input.store.eventCursor(input.runId);
      const usageBeforeTurn = usage;
      const steering = await input.store.drainSteering(input.runId);
      turnInput.push(...steering.map(({ message }) => message));
      messages.push(...steering.map(({ message }) => message));
      const steeringEvents: RunEventData[] = steering.map(({ author, message }) => ({
        type: "steering",
        author,
        text: messageText(message),
      }));
      await appendEvents(input, steeringEvents);

      const baseline = {
        model: input.model,
        instructions,
        messages: [...messages],
        tools: [...input.tools],
        turn,
      };
      let prepared = baseline;
      const preparationEvents: RunEventData[] = [];
      if (input.hooks?.prepareTurn !== undefined) {
        try {
          const hookResult = await input.hooks.prepareTurn(baseline);
          prepared = {
            model: hookResult.model,
            instructions: hookResult.instructions,
            messages: hookResult.messages,
            tools: hookResult.tools,
            turn,
          };
          preparationEvents.push(...(hookResult.events ?? []));
        } catch (error) {
          preparationEvents.push(hookErrorEvent("prepareTurn", error));
        }
      }
      await appendEvents(input, preparationEvents);

      const stream = input.modelPort.streamTurn({
        model: prepared.model,
        instructions: prepared.instructions,
        messages: [...prepared.messages],
        tools: [...prepared.tools],
        ...(input.thinking === undefined ? {} : { thinking: input.thinking }),
        ...(input.budget === undefined ? {} : { budget: input.budget }),
        abort: input.abort,
      });
      const streamEvents: RunEventData[] = [];
      for await (const event of stream) {
        streamEvents.push(event);
        if (event.type !== "elicitation" || !event.blocking) {
          await input.store.appendEvent(input.runId, event);
        }
      }
      const result = await stream.result;
      lastStopReason = result.stopReason;
      usage = addUsage(usage, result.usage);

      let toolResults: TranscriptMessage[] = [];
      let pause = blockingElicitation(streamEvents);
      let pendingToolCall: TurnRecord["pendingToolCall"];

      if (result.stopReason === "paused" && pause === undefined) {
        // A port reporting paused must have emitted the blocking elicitation;
        // without one the run could never be resumed, so fail as data.
        await input.store.appendEvent(input.runId, {
          type: "error",
          message: "model port reported paused without a blocking elicitation",
          recoverable: false,
        });
        await commit(input, turn, prepared.model, turnInput, result, toolResults);
        observeCommit(input, turn, result, toolResults);
        return {
          status: "finished",
          outcome: "failed",
          stopReason: "error",
          turns: turn + 1,
          usage,
        };
      }

      if (result.stopReason === "error" || result.stopReason === "aborted") {
        if (result.stopReason === "aborted") {
          await input.store.discardEventsAfter(input.runId, eventCursor);
          for (const queued of steering) await input.store.enqueueSteering(input.runId, queued);
          return {
            status: "finished",
            outcome: "cancelled",
            stopReason: "aborted",
            turns: turn,
            usage: usageBeforeTurn,
          };
        }
        await commit(input, turn, prepared.model, turnInput, result, toolResults);
        observeCommit(input, turn, result, toolResults);
        return {
          status: "finished",
          outcome: result.stopReason === "error" ? "failed" : "cancelled",
          stopReason: result.stopReason,
          turns: turn + 1,
          usage,
          ...(result.error === undefined ? {} : { error: result.error }),
        };
      }

      if (result.stopReason === "length" && result.toolCalls.length > 0) {
        const failed = result.toolCalls.map(truncatedToolResult);
        toolResults = failed.map(toToolResultMessage);
        await appendEvents(input, failed.map(toToolResultEvent));
      } else if (result.toolCalls.length > 0) {
        const streamGate =
          pause === undefined ? undefined : gatedStreamCall(result.toolCalls, pause);
        const batch = await executeToolBatch({
          calls: result.toolCalls,
          tools: prepared.tools,
          executor: input.toolExecutor,
          ...(streamGate === undefined
            ? {}
            : { gate: { callId: streamGate.callId, elicitation: pause! } }),
          onEvent: async (event) => {
            if (event.type !== "elicitation" || !event.blocking) {
              await input.store.appendEvent(input.runId, event);
            }
          },
          ...(input.hooks?.beforeToolCall === undefined
            ? {}
            : { beforeToolCall: input.hooks.beforeToolCall }),
          ...(input.hooks?.afterToolCall === undefined
            ? {}
            : { afterToolCall: input.hooks.afterToolCall }),
        });
        toolResults = batch.messages;
        pause = batch.pendingElicitation ?? pause;
        pendingToolCall = batch.pendingToolCall;
      }

      if (pause !== undefined) {
        const pausedResult: TurnResult = { ...result, stopReason: "paused" };
        const run = await input.store.getRun(input.runId);
        const state =
          run?.state === "running"
            ? pause.kind === "approval"
              ? "awaiting_approval"
              : "awaiting_input"
            : undefined;
        await commit(
          input,
          turn,
          prepared.model,
          turnInput,
          pausedResult,
          toolResults,
          pendingToolCall,
          {
            events: [pause, { type: "segment-end", reason: "paused" }],
            ...(state === undefined ? {} : { state }),
            elicitation: {
              runId: input.runId,
              event: pause,
              ...(input.elicitationExpiresAt === undefined
                ? {}
                : { expiresAt: input.elicitationExpiresAt }),
            },
          },
        );
        observeCommit(input, turn, pausedResult, toolResults);
        return { status: "paused", stopReason: "paused", turn, elicitation: pause, usage };
      }

      const contextAfterTurn = [...messages, result.message, ...toolResults];
      const stop = await shouldStop(input, turn, result, contextAfterTurn);
      await commit(input, turn, prepared.model, turnInput, result, toolResults);
      observeCommit(input, turn, result, toolResults);
      messages.push(result.message, ...toolResults);
      turnInput = [];
      turn += 1;

      if (stop || turn >= (input.maxTurns ?? DEFAULT_MAX_TURNS)) {
        return {
          status: "finished",
          outcome: "completed",
          stopReason: result.stopReason,
          turns: turn,
          usage,
        };
      }
      if (result.toolCalls.length > 0 || (await input.store.hasSteering(input.runId))) {
        continue;
      }
      break;
    }

    const followUps = await input.store.drainFollowUps(input.threadRef);
    if (followUps.length > 0) {
      // The answer that just ended is a finished segment: what a follow-up
      // draws is the next surface message, not more of the last one. The
      // follow-ups themselves land as `steering` events — the log's record of a
      // user message this run absorbed, without which the thread would show an
      // answer to a question nobody asked.
      const followUpEvents: RunEventData[] = [
        { type: "segment-end", reason: "completed" },
        ...followUps.map(({ author, message }) => ({
          type: "steering" as const,
          author,
          text: messageText(message),
        })),
      ];
      await appendEvents(input, followUpEvents);
      turnInput.push(...followUps.map(({ message }) => message));
      messages.push(...followUps.map(({ message }) => message));
      continue;
    }

    return {
      status: "finished",
      outcome: "completed",
      stopReason: lastStopReason,
      turns: turn,
      usage,
    };
  }
}

async function resumePendingTurn(
  input: LoopInput,
  turns: TurnRecord[],
  messages: TranscriptMessage[],
): Promise<void> {
  const pendingTurn = turns.at(-1);
  const pending = pendingTurn?.pendingToolCall;
  if (pendingTurn === undefined || pending === undefined) return;
  const elicitation = await input.store.getElicitation(pending.elicitationId);
  if (elicitation?.resolution === undefined) {
    throw new Error(`pending elicitation is unresolved: ${pending.elicitationId}`);
  }
  if (elicitation.resolution.decision === "expired") {
    throw new Error(`expired elicitation cannot resume: ${pending.elicitationId}`);
  }

  const calls: ToolCall[] = pendingTurn.message.blocks.flatMap((block) =>
    block.type === "toolCall"
      ? [
          {
            callId: block.callId,
            name: block.name,
            input: block.input,
            providerMeta: block.providerMeta,
          },
        ]
      : [],
  );
  const pendingIndex = calls.findIndex(({ callId }) => callId === pending.callId);
  if (pendingIndex < 0) throw new Error(`pending tool call is missing: ${pending.callId}`);
  const remaining = calls.slice(pendingIndex);
  const resumed: TranscriptMessage[] = [];

  if (elicitation.resolution.decision === "denied") {
    const deniedBy = elicitation.resolution.by.displayName ?? elicitation.resolution.by.principalId;
    const summary = `denied by ${deniedBy}${
      elicitation.resolution.reason === undefined ? "" : `: ${elicitation.resolution.reason}`
    }`;
    const denied: ToolExecutionResult = {
      callId: pending.callId,
      status: "denied",
      summary,
      output: summary,
    };
    await input.store.appendEvent(input.runId, toToolResultEvent(denied));
    resumed.push(toToolResultMessage(denied));
    remaining.shift();
  } else if (elicitation.resolution.decision === "answered") {
    const answered: ToolExecutionResult = {
      callId: pending.callId,
      status: "ok",
      summary: elicitation.resolution.optionId,
      output: elicitation.resolution.optionId,
    };
    await input.store.appendEvent(input.runId, toToolResultEvent(answered));
    resumed.push(toToolResultMessage(answered));
    remaining.shift();
  }

  if (remaining.length > 0) {
    const approvalId = elicitation.event.reference?.approvalId;
    const batch = await executeToolBatch({
      calls: remaining,
      tools: input.tools,
      executor: input.toolExecutor,
      ...(approvalId === undefined
        ? {}
        : { executionOptions: { [pending.callId]: { approvalId } } }),
      onEvent: async (event) => {
        await input.store.appendEvent(input.runId, event);
      },
      ...(input.hooks?.beforeToolCall === undefined
        ? {}
        : {
            beforeToolCall: async (hookInput) =>
              hookInput.call.callId === pending.callId
                ? { action: "execute" as const }
                : input.hooks!.beforeToolCall!(hookInput),
          }),
      ...(input.hooks?.afterToolCall === undefined
        ? {}
        : { afterToolCall: input.hooks.afterToolCall }),
    });
    if (batch.pendingElicitation !== undefined) {
      throw new Error("a resumed tool batch cannot park before the next model boundary");
    }
    resumed.push(...batch.messages);
  }

  const toolResults = [...pendingTurn.toolResults, ...resumed];
  await input.store.completePendingTurn(input.runId, pendingTurn.index, toolResults);
  messages.push(...resumed);
}

async function commit(
  input: LoopInput,
  turn: number,
  model: ModelRef,
  turnInput: TranscriptMessage[],
  result: TurnResult,
  toolResults: TranscriptMessage[],
  pendingToolCall?: TurnRecord["pendingToolCall"],
  transaction?: Pick<Parameters<RunStore["commitTurn"]>[0], "events" | "state" | "elicitation">,
): Promise<void> {
  await input.store.commitTurn({
    turn: {
      runId: input.runId,
      index: turn,
      model,
      ...(turnInput.length === 0 ? {} : { input: [...turnInput] }),
      message: result.message,
      toolResults,
      ...(pendingToolCall === undefined ? {} : { pendingToolCall }),
      stopReason: result.stopReason,
      usage: result.usage,
    },
    ...transaction,
  });
}

async function shouldStop(
  input: LoopInput,
  turn: number,
  result: TurnResult,
  messages: TranscriptMessage[],
): Promise<boolean> {
  if (input.hooks?.shouldStop === undefined) return false;
  try {
    return await input.hooks.shouldStop({ turn, result, messages });
  } catch (error) {
    await input.store.appendEvent(input.runId, hookErrorEvent("shouldStop", error));
    return false;
  }
}

async function appendEvents(input: LoopInput, events: RunEventData[]): Promise<void> {
  for (const event of events) {
    await input.store.appendEvent(input.runId, event);
  }
}

function observeCommit(
  input: LoopInput,
  turn: number,
  result: TurnResult,
  toolResults: TranscriptMessage[],
): void {
  if (input.hooks?.onTurnCommitted === undefined) return;
  const record = (error: unknown): void => {
    void input.store
      .appendEvent(input.runId, hookErrorEvent("onTurnCommitted", error))
      .catch(() => undefined);
  };
  try {
    void Promise.resolve(input.hooks.onTurnCommitted({ turn, result, toolResults })).catch(record);
  } catch (error) {
    record(error);
  }
}

/**
 * Rebuilds the model context from durable state alone.
 *
 * The thread's record covers the runs that came before; this run contributes
 * its committed turns, each one carrying the input it was given before its
 * output — so a resumed execution shows the model the same conversation the
 * first execution did, in the same order.
 */
function assembleCommittedMessages(
  threadMessages: TranscriptMessage[],
  turns: TurnRecord[],
): TranscriptMessage[] {
  return [
    ...threadMessages,
    ...turns.flatMap(({ input, message, toolResults }) => [
      ...(input ?? []),
      message,
      ...toolResults,
    ]),
  ];
}

function assembleInstructions(standing: SessionStanding): string {
  const sections = [standing.instructions];
  if (standing.rules.length > 0) {
    sections.push(
      ["Rules:", ...standing.rules.map((rule) => `[${rule.type}:${rule.id}] ${rule.content}`)].join(
        "\n",
      ),
    );
  }
  if (standing.skillIndex.length > 0) {
    sections.push(
      [
        "Skills:",
        ...standing.skillIndex.map((skill) => `- ${skill.name}: ${skill.description}`),
      ].join("\n"),
    );
  }
  return sections.filter((section) => section.length > 0).join("\n\n");
}

function blockingElicitation(
  events: RunEventData[],
): Extract<RunEventData, { type: "elicitation" }> | undefined {
  return events.find(
    (event): event is Extract<RunEventData, { type: "elicitation" }> =>
      event.type === "elicitation" && event.blocking,
  );
}

function gatedStreamCall(
  calls: ToolCall[],
  elicitation: Extract<RunEventData, { type: "elicitation" }>,
): ToolCall | undefined {
  const referenced = calls.find(({ callId }) => callId === elicitation.reference?.callId);
  if (referenced !== undefined) return referenced;

  // SDK approval events are expected to identify their call. If an adapter
  // omits or supplies an unknown callId, gate the first call so no later call
  // can leapfrog an unresolved approval.
  return calls[0];
}

function truncatedToolResult(call: ToolCall): ToolExecutionResult {
  const summary = "tool call was not executed because its input may have been truncated";
  return {
    callId: call.callId,
    status: "error",
    summary,
    output: summary,
  };
}

function hookErrorEvent(name: string, error: unknown): RunEventData {
  return {
    type: "error",
    message: `${name} hook failed: ${error instanceof Error ? error.message : String(error)}`,
    recoverable: true,
  };
}

function messageText(message: TranscriptMessage): string {
  return message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

function sumUsage(usages: Usage[]): Usage {
  return usages.reduce(addUsage, emptyUsage());
}

function addUsage(left: Usage, right: Usage): Usage {
  return {
    inputTokens: left.inputTokens + right.inputTokens,
    outputTokens: left.outputTokens + right.outputTokens,
    totalTokens: left.totalTokens + right.totalTokens,
    cacheReadTokens: left.cacheReadTokens + right.cacheReadTokens,
    cacheWriteTokens: left.cacheWriteTokens + right.cacheWriteTokens,
    costUsd: left.costUsd + right.costUsd,
  };
}

function emptyUsage(): Usage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    costUsd: 0,
  };
}
