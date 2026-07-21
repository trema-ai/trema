import type * as React from "react";

import { CopyButton } from "#/components/trema/copy-button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip.tsx";
import { cn } from "#/lib/utils.ts";

type IdChipProps = React.ComponentProps<"span"> & {
  id: string;
  visibleChars?: number;
};

function IdChip({ id, visibleChars = 8, className, ...props }: IdChipProps) {
  const truncated = id.length > visibleChars ? `${id.slice(0, visibleChars)}…` : id;

  return (
    <span
      data-slot="id-chip"
      className={cn("group/id-chip inline-flex items-center gap-0.5", className)}
      {...props}
    >
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="font-mono text-meta text-muted-foreground">{truncated}</span>
          </TooltipTrigger>
          <TooltipContent>
            <span className="font-mono">{id}</span>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
      <CopyButton
        value={id}
        className="opacity-0 transition-opacity group-focus-within/id-chip:opacity-100 group-hover/id-chip:opacity-100"
      />
    </span>
  );
}

export { IdChip, type IdChipProps };
