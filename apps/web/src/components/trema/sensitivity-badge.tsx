import type * as React from "react";

import { cn } from "#/lib/utils.ts";

type Sensitivity = "read" | "write" | "destructive";

const sensitivityClasses: Record<Sensitivity, string> = {
  read: "bg-muted text-muted-foreground",
  write: "bg-wait-soft text-wait",
  destructive: "bg-destructive-soft text-destructive",
};

type SensitivityBadgeProps = React.ComponentProps<"span"> & { sensitivity: Sensitivity };

function SensitivityBadge({ sensitivity, className, ...props }: SensitivityBadgeProps) {
  return (
    <span
      data-slot="sensitivity-badge"
      data-sensitivity={sensitivity}
      className={cn(
        "inline-flex w-fit shrink-0 items-center font-medium rounded-sm px-1.5 py-0.5 font-mono text-xs leading-4 tracking-[0.08em] uppercase",
        sensitivityClasses[sensitivity],
        className,
      )}
      {...props}
    >
      {sensitivity}
    </span>
  );
}

export { type Sensitivity, SensitivityBadge, type SensitivityBadgeProps };
