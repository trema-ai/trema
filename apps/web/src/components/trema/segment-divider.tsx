import type * as React from "react";

import { cn } from "#/lib/utils.ts";

type SegmentDividerProps = React.ComponentProps<"div"> & {
  reason: string;
  detail?: string;
};

function SegmentDivider({ reason, detail, className, ...props }: SegmentDividerProps) {
  return (
    <div
      data-slot="segment-divider"
      className={cn("flex items-center gap-3", className)}
      {...props}
    >
      <div className="h-px flex-1 bg-border" />
      <span className="flex shrink-0 items-center gap-1 rounded-full border bg-background px-2.5 py-0.5 font-mono text-meta text-muted-foreground">
        {reason}
        {detail !== undefined && <span>· {detail}</span>}
      </span>
      <div className="h-px flex-1 bg-border" />
    </div>
  );
}

export { SegmentDivider, type SegmentDividerProps };
