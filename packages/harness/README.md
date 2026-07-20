# `@trema/harness`

`@trema/harness` provides the durable run loop for Trema agents. Runs checkpoint at turn granularity, and failures become recorded data. A pause ends execution. Resume starts fresh execution that reads the stored log.

## Quick start

This TypeScript sketch uses the in-memory store and testing fakes. Replace them with production port implementations in a deployed host.

```ts
import { InMemoryRunStore, runLoop } from "@trema/harness";
import { FakeContextSession, FauxModelPort } from "@trema/harness/testing";

const runId = "run-2026-07-20-001";
const threadRef = "thread-support-42";
const usage = {
  inputTokens: 12,
  outputTokens: 8,
  totalTokens: 20,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0.0004,
};

const store = new InMemoryRunStore({
  now: () => new Date().toISOString(),
});
await store.createRun({
  id: runId,
  threadRef,
  state: "queued",
  trigger: "message",
  turnCount: 0,
});
await store.updateRunState(runId, "running");

const context = new FakeContextSession({
  sessionId: "session-support-42",
  mode: "service",
  scopeChain: [],
  standing: {
    instructions: "Answer support questions accurately.",
    rules: [],
    skillIndex: [],
  },
  tools: [],
  policySnapshot: {},
  snapshotHash: "snapshot-support-42",
});
const session = await context.open({
  surface: "support-chat",
  locationRef: { threadRef },
  requester: { principalId: "principal-42" },
});

const modelPort = new FauxModelPort([
  {
    events: [],
    result: {
      message: {
        role: "assistant",
        blocks: [{ type: "text", text: "Your request is complete." }],
      },
      toolCalls: [],
      stopReason: "stop",
      usage,
    },
  },
]);

const result = await runLoop({
  runId,
  threadRef,
  model: { id: "support-model" },
  standing: session.standing,
  threadMessages: [
    {
      role: "user",
      blocks: [{ type: "text", text: "Check my support request." }],
    },
  ],
  tools: session.tools,
  modelPort,
  store,
  toolExecutor: {
    async execute() {
      throw new Error("This sketch defines no tools.");
    },
  },
  abort: new AbortController().signal,
});

console.log(result.status);
```

The script prints `finished`.

## Run state machine

The store accepts only these transitions:

| State | Meaning | Legal next states |
| --- | --- | --- |
| `queued` | Execution has not started. | `running` |
| `running` | The run is executing turns. | `awaiting_approval`, `awaiting_input`, `completed`, `failed`, `cancelled` |
| `awaiting_approval` | A tool call needs approval. | `running`, `stale` |
| `awaiting_input` | The run needs requested input. | `running`, `stale` |
| `completed` | The run ended successfully. | None |
| `failed` | The run ended with a recorded failure. | None |
| `cancelled` | A recorded stop intent ended the run. | None |
| `stale` | An unresolved elicitation expired. | None |

## Ports

Hosts implement these contracts to connect the run loop to external systems:

| Port | Implementer | Contract |
| --- | --- | --- |
| `ModelPort` | Model adapter | Streams turn events and returns the final transcript, tool calls, stop reason, and usage. |
| `RunStore` | Persistence layer | Stores runs, turn checkpoints, events, queued input, stop intents, and elicitations. |
| `ContextSession` | Context service | Resolves standing context, tools, memory, connectors, approvals, and feedback. |
| `ToolExecutor` | Tool integration | Executes an allowed tool call and returns transcript output plus an event summary. |
| `Engine` | Host scheduler | Enqueues run execution outside the caller. |
| `Clock` | Host runtime | Supplies ISO 8601 timestamps for durable event envelopes. |
| `HarnessHooks` | Policy or observation layer | Adjusts turns, gates tool calls, stops loops, and observes committed turns. |

## Package layout

| Folder | Purpose |
| --- | --- |
| `src/core/` | Run states, model types, usage, tools, and transcript blocks. |
| `src/ports/` | Integration contracts implemented by hosts and adapters. |
| `src/events/` | Versioned run event schemas and forward-compatible parsing. |
| `src/loop/` | Turn execution, tool batches, checkpointing, steering, and follow-ups. |
| `src/run/` | Run lifecycle, retries, stops, interrupts, and elicitation resolution. |
| `src/dispatch/` | Idempotent intent routing and per-thread dispatch locking. |
| `src/memory/` | In-memory reference implementations of the store and engine. |
| `src/testing/` | Deterministic context and model fakes. |

## Stability

This package is pre-release. Its API is not yet stable.
