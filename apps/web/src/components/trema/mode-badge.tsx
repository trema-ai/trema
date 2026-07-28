import type * as React from "react";

import { cn } from "#web/lib/utils.ts";

type ApprovalModeValue = "ask" | "delegated" | "full";

const modeClasses: Record<ApprovalModeValue, string> = {
  ask: "bg-muted text-muted-foreground",
  delegated: "bg-wait-soft text-wait",
  full: "bg-destructive-soft text-destructive",
};

const modeLabels: Record<ApprovalModeValue, string> = {
  ask: "Ask for approval",
  delegated: "Approve for me",
  full: "Full access",
};

type ModeBadgeProps = React.ComponentProps<"span"> & { mode: ApprovalModeValue };

function ModeBadge({ mode, className, ...props }: ModeBadgeProps) {
  return (
    <span
      data-slot="mode-badge"
      data-mode={mode}
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-sm px-1.5 py-0.5 text-meta font-medium",
        modeClasses[mode],
        className,
      )}
      {...props}
    >
      {modeLabels[mode]}
    </span>
  );
}

export { type ApprovalModeValue, ModeBadge, type ModeBadgeProps };
