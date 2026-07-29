import type { RunEventData, Usage } from "@trema/harness";
import type { FoldInput, Projection } from "#projection/types.js";

export const at = "2026-07-19T12:00:00.000Z";
export const resolvedAt = "2026-07-19T12:00:01.000Z";

export const usage: Usage = {
  inputTokens: 2,
  outputTokens: 3,
  totalTokens: 5,
  cacheReadTokens: 1,
  cacheWriteTokens: 0,
  costUsd: 0.001,
};

export const principal = { principalId: "principal-1", displayName: "Nelson" };

/** Wraps one raw payload in the envelope shape the read paths deliver. */
export function envelope(seq: number, event: unknown): FoldInput {
  return { seq, at, event };
}

/** Builds a dense one-based log from typed payloads, as the emitters write it. */
export function log(events: readonly RunEventData[]): FoldInput[] {
  return events.map((event, index) => envelope(index + 1, event));
}

export interface Fixture {
  name: string;
  runId: string;
  events: FoldInput[];
  expected: Projection;
}

/**
 * One instance of every event type, arranged as a plausible park-and-resume
 * run (lifted from the harness schema test's event inventory).
 */
export const kitchenSink: Fixture = {
  name: "kitchen sink",
  runId: "run-1",
  events: log([
    { type: "run-started", trigger: "message" },
    { type: "turn-started", turn: 0, model: "test/model" },
    { type: "reasoning-start", blockId: "reasoning-1" },
    { type: "reasoning-delta", blockId: "reasoning-1", delta: "hmm" },
    { type: "reasoning-end", blockId: "reasoning-1", redacted: true },
    { type: "text-start", blockId: "text-1" },
    { type: "text-delta", blockId: "text-1", delta: "hello" },
    { type: "tool-start", callId: "call-1", name: "read", title: "Read", kind: "read" },
    { type: "tool-input-delta", callId: "call-1", delta: '{"path":' },
    { type: "tool-input", callId: "call-1", input: { path: "README.md" } },
    { type: "tool-note", callId: "call-1", note: "working" },
    { type: "text-end", blockId: "text-1" },
    {
      type: "elicitation",
      elicitationId: "elicit-1",
      kind: "approval",
      prompt: "Proceed?",
      reference: { callId: "call-1", approvalId: "approval-1" },
      options: [{ id: "approve", label: "Approve", style: "primary", scope: "once" }],
      blocking: true,
    },
    { type: "segment-end", reason: "paused" },
    {
      type: "elicitation-resolved",
      elicitationId: "elicit-1",
      optionId: "approve",
      by: principal,
      at: resolvedAt,
    },
    { type: "run-started", trigger: "resume" },
    {
      type: "tool-result",
      callId: "call-1",
      status: "ok",
      summary: "file read",
      outputRef: "output-1",
    },
    { type: "steering", author: principal, text: "also check staging" },
    { type: "data", name: "compaction", id: "compact-1", data: { removed: 2 } },
    { type: "error", message: "transient blip", recoverable: true },
    { type: "turn-finished", turn: 0, stopReason: "stop", usage },
    { type: "run-finished", outcome: "completed", usage },
  ]),
  expected: {
    runId: "run-1",
    status: "completed",
    segments: [
      {
        index: 0,
        parts: [
          { kind: "reasoning", id: "reasoning-1", status: "done", text: "hmm", redacted: true },
          { kind: "text", id: "text-1", status: "done", markdown: "hello" },
          {
            kind: "activity",
            id: "call-1",
            status: "done",
            callId: "call-1",
            name: "read",
            title: "Read",
            toolKind: "read",
            input: '{"path":"README.md"}',
            notes: ["working"],
            result: { status: "ok", summary: "file read", outputRef: "output-1" },
          },
          {
            kind: "elicitation",
            id: "elicit-1",
            elicitationId: "elicit-1",
            elicitationKind: "approval",
            prompt: "Proceed?",
            reference: { callId: "call-1", approvalId: "approval-1" },
            options: [{ id: "approve", label: "Approve", style: "primary", scope: "once" }],
            blocking: true,
            resolution: { optionId: "approve", by: principal, at: resolvedAt },
          },
        ],
        end: { reason: "paused" },
      },
      {
        index: 1,
        parts: [
          { kind: "steering", id: "steering-18", author: principal, text: "also check staging" },
          { kind: "data", id: "compact-1", name: "compaction", data: { removed: 2 } },
          { kind: "error", id: "error-20", message: "transient blip", recoverable: true },
        ],
      },
    ],
    usage,
    unknownEvents: 0,
    lastSeq: 22,
  },
};

/**
 * The acceptance run: park on a blocking approval, resolve, resume, finish.
 * The gated tool call has no `tool-start` in the log — the resumed execution
 * reports only its result — so the fold opens the activity implicitly.
 */
export const parkResume: Fixture = {
  name: "park, resolve, resume",
  runId: "run-2",
  events: log([
    { type: "run-started", trigger: "message" },
    {
      type: "elicitation",
      elicitationId: "elicit-1",
      kind: "approval",
      prompt: "Approve the deployment lookup?",
      reference: { callId: "call-1", approvalId: "approval-1" },
      options: [{ id: "approve", label: "Approve" }],
      blocking: true,
    },
    { type: "segment-end", reason: "paused" },
    {
      type: "elicitation-resolved",
      elicitationId: "elicit-1",
      optionId: "approve",
      by: principal,
      at: resolvedAt,
    },
    { type: "run-started", trigger: "resume" },
    { type: "tool-result", callId: "call-1", status: "ok", summary: "deployment is healthy" },
    { type: "text-start", blockId: "text-2" },
    { type: "text-delta", blockId: "text-2", delta: "Deployment is healthy." },
    { type: "text-end", blockId: "text-2" },
    { type: "run-finished", outcome: "completed", usage },
  ]),
  expected: {
    runId: "run-2",
    status: "completed",
    segments: [
      {
        index: 0,
        parts: [
          {
            kind: "elicitation",
            id: "elicit-1",
            elicitationId: "elicit-1",
            elicitationKind: "approval",
            prompt: "Approve the deployment lookup?",
            reference: { callId: "call-1", approvalId: "approval-1" },
            options: [{ id: "approve", label: "Approve" }],
            blocking: true,
            resolution: { optionId: "approve", by: principal, at: resolvedAt },
          },
        ],
        end: { reason: "paused" },
      },
      {
        index: 1,
        parts: [
          {
            kind: "activity",
            id: "call-1",
            status: "done",
            callId: "call-1",
            name: "unknown",
            title: "Tool call",
            toolKind: "other",
            notes: [],
            result: { status: "ok", summary: "deployment is healthy" },
          },
          { kind: "text", id: "text-2", status: "done", markdown: "Deployment is healthy." },
        ],
      },
    ],
    usage,
    unknownEvents: 0,
    lastSeq: 10,
  },
};

/**
 * Follow-up absorption: the finished answer closes its segment, the absorbed
 * user message lands as steering, and the next answer opens a fresh segment.
 */
export const followUps: Fixture = {
  name: "follow-up absorption",
  runId: "run-3",
  events: log([
    { type: "run-started", trigger: "message" },
    { type: "text-start", blockId: "text-1" },
    { type: "text-delta", blockId: "text-1", delta: "first answer" },
    { type: "text-end", blockId: "text-1" },
    { type: "segment-end", reason: "completed" },
    { type: "steering", author: principal, text: "one more thing" },
    { type: "text-start", blockId: "text-2" },
    { type: "text-delta", blockId: "text-2", delta: "follow-up answer" },
    { type: "text-end", blockId: "text-2" },
    { type: "run-finished", outcome: "completed", usage },
  ]),
  expected: {
    runId: "run-3",
    status: "completed",
    segments: [
      {
        index: 0,
        parts: [{ kind: "text", id: "text-1", status: "done", markdown: "first answer" }],
        end: { reason: "completed" },
      },
      {
        index: 1,
        parts: [
          { kind: "steering", id: "steering-6", author: principal, text: "one more thing" },
          { kind: "text", id: "text-2", status: "done", markdown: "follow-up answer" },
        ],
      },
    ],
    usage,
    unknownEvents: 0,
    lastSeq: 10,
  },
};

/**
 * A tool batch gated mid-way (from the loop's beforeToolCall pause): the log
 * opens with a bare tool result — no `run-started`, no `tool-start` — and
 * parks. The fold stays total and the pause still reads as paused.
 */
export const gatedBatch: Fixture = {
  name: "gated tool batch",
  runId: "run-4",
  events: log([
    { type: "tool-result", callId: "call-1", status: "ok", summary: "lookup completed" },
    {
      type: "elicitation",
      elicitationId: "elicit-hook",
      kind: "confirmation",
      prompt: "Run the second call?",
      reference: { callId: "call-2" },
      options: [{ id: "yes", label: "Yes" }],
      blocking: true,
    },
    { type: "segment-end", reason: "paused" },
  ]),
  expected: {
    runId: "run-4",
    status: "paused",
    segments: [
      {
        index: 0,
        parts: [
          {
            kind: "activity",
            id: "call-1",
            status: "done",
            callId: "call-1",
            name: "unknown",
            title: "Tool call",
            toolKind: "other",
            notes: [],
            result: { status: "ok", summary: "lookup completed" },
          },
          {
            kind: "elicitation",
            id: "elicit-hook",
            elicitationId: "elicit-hook",
            elicitationKind: "confirmation",
            prompt: "Run the second call?",
            reference: { callId: "call-2" },
            options: [{ id: "yes", label: "Yes" }],
            blocking: true,
          },
        ],
        end: { reason: "paused" },
      },
    ],
    unknownEvents: 0,
    lastSeq: 3,
  },
};

export const fixtures: Fixture[] = [kitchenSink, parkResume, followUps, gatedBatch];
