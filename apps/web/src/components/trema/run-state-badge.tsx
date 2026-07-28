import type * as React from "react";

import { StatusDot } from "#web/components/trema/status-dot.tsx";
import { cn } from "#web/lib/utils.ts";

/** The run lifecycle exactly as the API reports it, never a lossy mapping. */
type RunState =
  | "queued"
  | "running"
  | "awaiting_approval"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled"
  | "stale";

const stateTone: Record<RunState, "go" | "wait" | "run" | "destructive" | "neutral"> = {
  queued: "neutral",
  running: "run",
  awaiting_approval: "wait",
  awaiting_input: "wait",
  completed: "go",
  failed: "destructive",
  cancelled: "neutral",
  stale: "neutral",
};

const stateLabel: Record<RunState, string> = {
  queued: "Queued",
  running: "Running",
  awaiting_approval: "Awaiting approval",
  awaiting_input: "Awaiting input",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  stale: "Stale",
};

type RunStateBadgeProps = React.ComponentProps<"span"> & { state: RunState };

function RunStateBadge({ state, className, ...props }: RunStateBadgeProps) {
  return (
    <span
      data-slot="run-state-badge"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1.5 text-chrome",
        state === "stale" ? "text-muted-foreground" : "text-foreground",
        className,
      )}
      {...props}
    >
      <StatusDot tone={stateTone[state]} />
      {stateLabel[state]}
    </span>
  );
}

export { type RunState, RunStateBadge, type RunStateBadgeProps };
