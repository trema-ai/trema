export type RunState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

export type Trigger = "message" | "api" | "schedule" | "retry" | "resume";

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

export function canTransition(from: RunState, to: RunState): boolean {
  return (LEGAL_RUN_STATE_TRANSITIONS[from] as readonly RunState[]).includes(to);
}
