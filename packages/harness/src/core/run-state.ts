/** Durable execution state for a run. */
export type RunState =
  /** The run exists but execution has not started. */
  | "queued"
  /** The run is executing turns. */
  | "running"
  /** The run is paused for approval of a tool call. */
  | "awaiting_approval"
  /** The run is paused for requested input. */
  | "awaiting_input"
  /** The run ended successfully. */
  | "completed"
  /** The run ended with a recorded failure. */
  | "failed"
  /** A recorded stop intent ended the run. */
  | "cancelled"
  /** An unresolved elicitation expired, so the run cannot resume. */
  | "stale";

/** Cause recorded when execution starts. */
export type Trigger = "message" | "api" | "schedule" | "retry" | "resume";

/** Complete ordered set of run states. */
export const RUN_STATES = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_input",
  "completed",
  "failed",
  "cancelled",
  "stale",
] as const satisfies readonly RunState[];

/** Legal next states for each run state; terminal states have no successors. */
export const LEGAL_RUN_STATE_TRANSITIONS = {
  queued: ["running"],
  running: ["awaiting_approval", "awaiting_input", "completed", "failed", "cancelled"],
  awaiting_approval: ["running", "stale"],
  awaiting_input: ["running", "stale"],
  completed: [],
  failed: [],
  cancelled: [],
  stale: [],
} as const satisfies Readonly<Record<RunState, readonly RunState[]>>;

/** Returns whether `to` is a legal immediate successor of `from`. */
export function canTransition(from: RunState, to: RunState): boolean {
  return (LEGAL_RUN_STATE_TRANSITIONS[from] as readonly RunState[]).includes(to);
}
