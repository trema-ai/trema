import { ChevronRight, Lock } from "lucide-react";
import type * as React from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import { cn } from "#web/lib/utils.ts";

type ReasoningBlockProps = {
  redacted?: boolean;
  children?: React.ReactNode;
  className?: string;
};

/** Reasoning as a machinery row; a redacted block shows presence, never content. */
function ReasoningBlock({ redacted, children, className }: ReasoningBlockProps) {
  if (redacted) {
    return (
      <div
        data-slot="reasoning-block"
        data-redacted="true"
        className={cn(
          "flex items-center gap-2 py-0.5 text-chrome text-muted-foreground",
          className,
        )}
      >
        <Lock className="size-3 shrink-0" />
        Reasoning (redacted)
      </div>
    );
  }

  return (
    <Collapsible data-slot="reasoning-block" className={className}>
      <CollapsibleTrigger className="group -mx-1.5 flex items-center gap-2 rounded-sm px-1.5 py-0.5 text-chrome text-muted-foreground hover:bg-muted/50 hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        Reasoning
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1.5 ml-[5px] border-l pl-4 text-meta text-muted-foreground">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export { ReasoningBlock, type ReasoningBlockProps };
