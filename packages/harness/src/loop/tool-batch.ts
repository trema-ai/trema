import type { ToolCall, ToolDef, TranscriptMessage } from "#/core/index.js";
import type { RunEventData } from "#/events/index.js";
import type {
  AfterToolCallHook,
  BeforeToolCallHook,
  BeforeToolCallResult,
  ToolExecutionOptions,
  ToolExecutionResult,
  ToolExecutor,
} from "#/ports/index.js";

/** Calls, definitions, executor, and hooks for one assistant-ordered tool batch. */
export interface ToolBatchInput {
  calls: ToolCall[];
  tools: ToolDef[];
  executor: ToolExecutor;
  /** Resolved approvals indexed by the original call identifier. */
  executionOptions?: Readonly<Record<string, ToolExecutionOptions>>;
  beforeToolCall?: BeforeToolCallHook;
  afterToolCall?: AfterToolCallHook;
  /** Existing gate that stops execution before its referenced call. */
  gate?: {
    callId: string;
    elicitation: Extract<RunEventData, { type: "elicitation" }>;
  };
  /** Receives tool and recoverable hook events as they occur. */
  onEvent?: (event: RunEventData) => Promise<void> | void;
}

/** Tool call that remains after a blocking elicitation. */
export interface PendingToolCall {
  callId: string;
  elicitationId: string;
}

/** Ordered tool outputs, transcript messages, events, and any pending elicitation. */
export interface ToolBatchResult {
  results: ToolExecutionResult[];
  messages: TranscriptMessage[];
  events: RunEventData[];
  pendingElicitation?: Extract<RunEventData, { type: "elicitation" }>;
  pendingToolCall?: PendingToolCall;
}

interface PreparedCall {
  original: ToolCall;
  call: ToolCall;
  definition: ToolDef;
  immediateResult?: ToolExecutionResult;
}

interface PreparedBatch {
  calls: PreparedCall[];
  events: RunEventData[];
  pendingElicitation?: Extract<RunEventData, { type: "elicitation" }>;
  pendingToolCall?: PendingToolCall;
}

/**
 * Executes calls in parallel unless any definition requires sequential execution.
 * Results retain assistant order, and a blocking elicitation stops before its call.
 */
export async function executeToolBatch(input: ToolBatchInput): Promise<ToolBatchResult> {
  const prepared = await prepareCalls(input);
  const mustRunSequentially = prepared.calls.some(
    ({ definition }) => definition.execution === "sequential",
  );
  const completed: Array<{ result: ToolExecutionResult; events: RunEventData[] }> = [];

  if (mustRunSequentially) {
    for (const call of prepared.calls) {
      const completion = await executePreparedCall(call, input);
      completed.push(completion);
      await emitCompletion(input, completion);
    }
  } else {
    completed.push(
      ...(await Promise.all(
        prepared.calls.map(async (call) => {
          const completion = await executePreparedCall(call, input);
          await emitCompletion(input, completion);
          return completion;
        }),
      )),
    );
  }

  const results = completed.map(({ result }) => result);
  if (prepared.pendingElicitation !== undefined && input.gate === undefined) {
    await input.onEvent?.(prepared.pendingElicitation);
  }
  const batch = {
    results,
    messages: results.map(toToolResultMessage),
    events: [
      ...prepared.events,
      ...completed.flatMap(({ events }) => events),
      ...results.map(toToolResultEvent),
      ...(prepared.pendingElicitation === undefined || input.gate !== undefined
        ? []
        : [prepared.pendingElicitation]),
    ],
  };
  return prepared.pendingElicitation === undefined
    ? batch
    : {
        ...batch,
        pendingElicitation: prepared.pendingElicitation,
        ...(prepared.pendingToolCall === undefined
          ? {}
          : { pendingToolCall: prepared.pendingToolCall }),
      };
}

async function prepareCalls(input: ToolBatchInput): Promise<PreparedBatch> {
  const prepared: PreparedCall[] = [];
  const events: RunEventData[] = [];

  for (const original of input.calls) {
    if (input.gate?.callId === original.callId) {
      return {
        calls: prepared,
        events,
        pendingElicitation: input.gate.elicitation,
        pendingToolCall: {
          callId: original.callId,
          elicitationId: input.gate.elicitation.elicitationId,
        },
      };
    }

    const definition = input.tools.find(({ name }) => name === original.name);
    if (definition === undefined) {
      prepared.push({
        original,
        call: original,
        definition: unavailableDefinition(original.name),
        immediateResult: errorResult(original, `tool no longer available: ${original.name}`),
      });
      continue;
    }

    let decision: BeforeToolCallResult = { action: "execute" };
    if (input.beforeToolCall !== undefined) {
      try {
        decision = await input.beforeToolCall({ call: original, definition });
      } catch (error) {
        const message = `beforeToolCall hook failed: ${errorMessage(error)}`;
        const event = { type: "error" as const, message, recoverable: true };
        events.push(event);
        await input.onEvent?.(event);
        prepared.push({
          original,
          call: original,
          definition,
          immediateResult: errorResult(original, message),
        });
        continue;
      }
    }

    if (decision.action === "elicit") {
      return {
        calls: prepared,
        events,
        pendingElicitation: decision.event,
        pendingToolCall: {
          callId: original.callId,
          elicitationId: decision.event.elicitationId,
        },
      };
    }
    if (decision.action === "block") {
      prepared.push({
        original,
        call: original,
        definition,
        immediateResult: errorResult(original, decision.summary),
      });
      continue;
    }

    prepared.push({ original, call: decision.call ?? original, definition });
  }

  return { calls: prepared, events };
}

async function emitCompletion(
  input: ToolBatchInput,
  completion: { result: ToolExecutionResult; events: RunEventData[] },
): Promise<void> {
  for (const event of completion.events) {
    await input.onEvent?.(event);
  }
  await input.onEvent?.(toToolResultEvent(completion.result));
}

async function executePreparedCall(
  prepared: PreparedCall,
  input: ToolBatchInput,
): Promise<{ result: ToolExecutionResult; events: RunEventData[] }> {
  if (prepared.immediateResult !== undefined) {
    return { result: prepared.immediateResult, events: [] };
  }

  let result: ToolExecutionResult;
  try {
    result = await input.executor.execute(
      prepared.call,
      prepared.definition,
      input.executionOptions?.[prepared.original.callId],
    );
  } catch (error) {
    result = errorResult(prepared.original, `tool execution failed: ${errorMessage(error)}`);
  }

  if (input.afterToolCall === undefined) {
    return { result, events: [] };
  }

  try {
    return {
      result: await input.afterToolCall({
        call: prepared.call,
        definition: prepared.definition,
        result,
      }),
      events: [],
    };
  } catch (error) {
    return {
      result,
      events: [
        {
          type: "error",
          message: `afterToolCall hook failed: ${errorMessage(error)}`,
          recoverable: true,
        },
      ],
    };
  }
}

export function toToolResultMessage(result: ToolExecutionResult): TranscriptMessage {
  return {
    role: "toolResult",
    toolCallId: result.callId,
    blocks:
      typeof result.output === "string" ? [{ type: "text", text: result.output }] : result.output,
    status: result.status,
  };
}

export function toToolResultEvent(result: ToolExecutionResult): RunEventData {
  const base = {
    type: "tool-result" as const,
    callId: result.callId,
    status: result.status,
    summary: result.summary,
  };
  return result.outputRef === undefined ? base : { ...base, outputRef: result.outputRef };
}

function errorResult(call: ToolCall, summary: string): ToolExecutionResult {
  return {
    callId: call.callId,
    status: "error",
    summary,
    output: summary,
  };
}

function unavailableDefinition(name: string): ToolDef {
  return {
    name,
    title: name,
    description: "Unavailable tool",
    schema: {},
    kind: "other",
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
