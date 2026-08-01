import type { PrincipalRef, RunEventData, ToolKind, Usage } from "@trema/harness";

/** Whether a part is still receiving events or has settled. */
export type Status = "streaming" | "done";

/**
 * Run status mirrored from lifecycle events only — never inferred from content.
 * `pending` before any event; `running` after `run-started`; `paused` after
 * `segment-end{paused}` until a subsequent `run-started` resumes; the terminal
 * states come from `run-finished.outcome`.
 */
export type RunStatus = "pending" | "running" | "paused" | "completed" | "failed" | "cancelled";

/** One choice offered by an elicitation, as recorded in its event. */
export type ElicitationOption = Extract<RunEventData, { type: "elicitation" }>["options"][number];

/** Streamed model prose. `id` is the event `blockId`. */
export interface TextPart {
  kind: "text";
  id: string;
  status: Status;
  markdown: string;
}

/** Streamed model reasoning. `id` is the event `blockId`. */
export interface ReasoningPart {
  kind: "reasoning";
  id: string;
  status: Status;
  text: string;
  redacted?: boolean;
}

/** One tool call. `id` is the `callId`; grouping consecutive calls is presentation. */
export interface ActivityPart {
  kind: "activity";
  id: string;
  status: Status;
  callId: string;
  name: string;
  title: string;
  toolKind: ToolKind;
  connector?: {
    key: string;
    displayName: string;
    logoUrl?: string;
    account?: {
      source: "personal" | "organization";
    };
  };
  /** Streamed input accumulation (`tool-input-delta`), replaced by `tool-input`. */
  input?: string;
  /** Bounded progress lines from `tool-note`. */
  notes: string[];
  result?: { status: "ok" | "error" | "denied"; summary: string; outputRef?: string };
}

/** A user message the run absorbed mid-flight. `id` derives from the event seq. */
export interface SteeringPart {
  kind: "steering";
  id: string;
  author: PrincipalRef;
  text: string;
}

/** A question to a human; carries its resolution once `elicitation-resolved` lands. */
export interface ElicitationPart {
  kind: "elicitation";
  id: string;
  elicitationId: string;
  elicitationKind: "approval" | "confirmation" | "choice" | "form";
  prompt: string;
  reference?: {
    callId?: string;
    approvalId?: string;
    itemId?: string;
    automationId?: string;
  };
  options: ElicitationOption[];
  blocking: boolean;
  resolution?: { optionId: string; by: PrincipalRef; at: string };
}

/** A recorded failure. `id` derives from the event seq. */
export interface ErrorPart {
  kind: "error";
  id: string;
  message: string;
  recoverable: boolean;
}

/** A named payload for capable surfaces; reconciles in place by `id`. */
export interface DataPart {
  kind: "data";
  id: string;
  name: string;
  data: unknown;
}

/** Typed, ordered unit of a projection; order is the seq order of first events. */
export type Part =
  | TextPart
  | ReasoningPart
  | ActivityPart
  | SteeringPart
  | ElicitationPart
  | ErrorPart
  | DataPart;

/** Why a segment closed, from `segment-end`. */
export type SegmentEndReason = "paused" | "overflow" | "completed" | "handoff";

/**
 * One surface-message-sized unit of the run. A segment exists once it has a
 * part; `end` is set only by an explicit `segment-end` event.
 */
export interface Segment {
  /** Zero-based within the run. */
  index: number;
  parts: Part[];
  end?: { reason: SegmentEndReason };
}

/** The derived, rebuildable message projection of one run's event log. */
export interface Projection {
  runId: string;
  status: RunStatus;
  segments: Segment[];
  /** From `run-finished.usage` when present. */
  usage?: Usage;
  /** Events skipped as unknown types or malformed known payloads. */
  unknownEvents: number;
  /** Highest seq folded — the incremental cursor for paged reads and SSE. */
  lastSeq: number;
}

/**
 * One event as both read paths deliver it: the paged API and SSE frames carry
 * the recorded payload as-is, so `event` is untrusted and possibly unknown.
 */
export interface FoldInput {
  seq: number;
  at: string;
  event: unknown;
}
