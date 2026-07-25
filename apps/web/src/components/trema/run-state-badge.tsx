import type * as React from "react";

import { StatusDot } from "#web/components/trema/status-dot.tsx";
import { cn } from "#web/lib/utils.ts";

type RunState = "queued" | "running" | "paused" | "finished" | "failed" | "stale";

const stateTone: Record<RunState, "go" | "wait" | "run" | "destructive" | "neutral"> = {
  queued: "neutral",
  running: "run",
  paused: "wait",
  finished: "go",
  failed: "destructive",
  stale: "neutral",
};

type RunStateBadgeProps = React.ComponentProps<"span"> & { state: RunState };

function RunStateBadge({ state, className, ...props }: RunStateBadgeProps) {
  return (
    <span
      data-slot="run-state-badge"
      data-state={state}
      className={cn(
        "inline-flex items-center gap-1.5 text-chrome capitalize",
        state === "stale" ? "text-muted-foreground" : "text-foreground",
        className,
      )}
      {...props}
    >
      <StatusDot tone={stateTone[state]} />
      {state}
    </span>
  );
}

export { type RunState, RunStateBadge, type RunStateBadgeProps };
