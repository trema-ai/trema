import type * as React from "react";

import { cn } from "#/lib/utils.ts";

type ScopeBadgeProps = React.ComponentProps<"span"> & { scope: string };

function ScopeBadge({ scope, className, ...props }: ScopeBadgeProps) {
  return (
    <span
      data-slot="scope-badge"
      className={cn(
        "inline-flex w-fit shrink-0 items-center rounded-sm border px-1.5 py-0.5 font-mono text-meta text-muted-foreground",
        className,
      )}
      {...props}
    >
      {scope}
    </span>
  );
}

export { ScopeBadge, type ScopeBadgeProps };
