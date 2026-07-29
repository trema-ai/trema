import { z } from "zod";

/** Runtime schema for token counts and cost in United States dollars. */
export const UsageSchema = z.object({
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  totalTokens: z.number().nonnegative(),
  cacheReadTokens: z.number().nonnegative(),
  cacheWriteTokens: z.number().nonnegative(),
  costUsd: z.number().nonnegative(),
});

/** Runtime schema for a principal recorded in run events. */
export const PrincipalRefSchema = z.object({
  principalId: z.string(),
  displayName: z.string().optional(),
});

const RunStartedEventSchema = z.object({
  type: z.literal("run-started"),
  // The closed trigger taxonomy (message/api/schedule/retry/resume); the
  // sketched mention/dm/automation vocabulary collapses onto it.
  trigger: z.enum(["message", "api", "schedule", "retry", "resume"]),
});

const RunFinishedEventSchema = z.object({
  type: z.literal("run-finished"),
  outcome: z.enum(["completed", "failed", "cancelled"]),
  errorMessage: z.string().optional(),
  usage: UsageSchema.optional(),
});

const TurnStartedEventSchema = z.object({
  type: z.literal("turn-started"),
  turn: z.number().int().nonnegative(),
  model: z.string(),
});

const TurnFinishedEventSchema = z.object({
  type: z.literal("turn-finished"),
  turn: z.number().int().nonnegative(),
  stopReason: z.enum(["stop", "toolUse", "length", "error", "aborted", "paused"]),
  usage: UsageSchema,
});

const TextStartEventSchema = z.object({ type: z.literal("text-start"), blockId: z.string() });
const TextDeltaEventSchema = z.object({
  type: z.literal("text-delta"),
  blockId: z.string(),
  delta: z.string(),
});
const TextEndEventSchema = z.object({ type: z.literal("text-end"), blockId: z.string() });
const ReasoningStartEventSchema = z.object({
  type: z.literal("reasoning-start"),
  blockId: z.string(),
});
const ReasoningDeltaEventSchema = z.object({
  type: z.literal("reasoning-delta"),
  blockId: z.string(),
  delta: z.string(),
});
const ReasoningEndEventSchema = z.object({
  type: z.literal("reasoning-end"),
  blockId: z.string(),
  redacted: z.boolean().optional(),
});

const ToolStartEventSchema = z.object({
  type: z.literal("tool-start"),
  callId: z.string(),
  name: z.string(),
  title: z.string(),
  kind: z.enum(["read", "edit", "search", "execute", "fetch", "connector", "other"]),
  connector: z
    .object({
      key: z.string(),
      displayName: z.string(),
      logoUrl: z.string().optional(),
    })
    .optional(),
});
const ToolInputDeltaEventSchema = z.object({
  type: z.literal("tool-input-delta"),
  callId: z.string(),
  delta: z.string(),
});
const ToolInputEventSchema = z.object({
  type: z.literal("tool-input"),
  callId: z.string(),
  input: z.unknown(),
});
const ToolNoteEventSchema = z.object({
  type: z.literal("tool-note"),
  callId: z.string(),
  note: z.string(),
});
const ToolResultEventSchema = z.object({
  type: z.literal("tool-result"),
  callId: z.string(),
  status: z.enum(["ok", "error", "denied"]),
  summary: z.string(),
  outputRef: z.string().optional(),
});

const ElicitationEventSchema = z.object({
  type: z.literal("elicitation"),
  elicitationId: z.string(),
  kind: z.enum(["approval", "confirmation", "choice", "form"]),
  prompt: z.string(),
  reference: z
    .object({
      callId: z.string().optional(),
      approvalId: z.string().optional(),
      itemId: z.string().optional(),
      automationId: z.string().optional(),
    })
    .optional(),
  options: z.array(
    z.object({
      id: z.string(),
      label: z.string(),
      style: z.enum(["primary", "danger"]).optional(),
      scope: z.enum(["once", "run", "always"]).optional(),
    }),
  ),
  blocking: z.boolean(),
});
const ElicitationResolvedEventSchema = z.object({
  type: z.literal("elicitation-resolved"),
  elicitationId: z.string(),
  optionId: z.string(),
  by: PrincipalRefSchema,
  at: z.iso.datetime(),
});
const SegmentEndEventSchema = z.object({
  type: z.literal("segment-end"),
  reason: z.enum(["paused", "overflow", "completed", "handoff"]),
});
const SteeringEventSchema = z.object({
  type: z.literal("steering"),
  author: PrincipalRefSchema,
  text: z.string(),
});
const ErrorEventSchema = z.object({
  type: z.literal("error"),
  message: z.string(),
  recoverable: z.boolean(),
});
const DataEventSchema = z.object({
  type: z.literal("data"),
  name: z.string(),
  id: z.string().optional(),
  data: z.unknown(),
  transient: z.boolean().optional(),
});

/** Runtime schema for every known run event payload. */
export const RunEventDataSchema = z.discriminatedUnion("type", [
  RunStartedEventSchema,
  RunFinishedEventSchema,
  TurnStartedEventSchema,
  TurnFinishedEventSchema,
  TextStartEventSchema,
  TextDeltaEventSchema,
  TextEndEventSchema,
  ReasoningStartEventSchema,
  ReasoningDeltaEventSchema,
  ReasoningEndEventSchema,
  ToolStartEventSchema,
  ToolInputDeltaEventSchema,
  ToolInputEventSchema,
  ToolNoteEventSchema,
  ToolResultEventSchema,
  ElicitationEventSchema,
  ElicitationResolvedEventSchema,
  SegmentEndEventSchema,
  SteeringEventSchema,
  ErrorEventSchema,
  DataEventSchema,
]);

/** Runtime schema for a version-one known event envelope. */
export const RunEventSchema = z.object({
  runId: z.string(),
  /** One-based sequence number, dense within a run. */
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  /** Event envelope schema version. */
  v: z.literal(1),
  event: RunEventDataSchema,
});

const UnknownRunEventSchema = z.object({
  runId: z.string(),
  seq: z.number().int().positive(),
  at: z.iso.datetime(),
  v: z.literal(1),
  event: z.object({ type: z.string() }).loose(),
});

/** Payload for a known event in the run log. */
export type RunEventData = z.infer<typeof RunEventDataSchema>;
/** Versioned envelope for a known event in the run log. */
export type RunEvent = z.infer<typeof RunEventSchema>;
/** Principal identity recorded with an event or intent. */
export type PrincipalRef = z.infer<typeof PrincipalRefSchema>;
/** Versioned envelope whose event type this package does not recognize. */
export type UnknownRunEvent = z.infer<typeof UnknownRunEventSchema>;

/** Known events are validated fully; unknown event types retain their loose payload for forward compatibility. */
export type ReadRunEventResult =
  | { kind: "known"; value: RunEvent }
  | { kind: "unknown"; value: UnknownRunEvent };

/**
 * Parses a version-one event envelope and separates known event types from unknown types.
 * Unknown events remain available so older readers can retain or skip newer log entries.
 * Malformed known events fail validation instead of becoming unknown events.
 */
export function parseRunEvent(input: unknown): ReadRunEventResult {
  const candidate = UnknownRunEventSchema.parse(input);
  const knownType = RunEventDataSchema.options.some(
    (schema) => schema.shape.type.value === candidate.event.type,
  );

  if (!knownType) {
    return { kind: "unknown", value: candidate };
  }

  return { kind: "known", value: RunEventSchema.parse(input) };
}
