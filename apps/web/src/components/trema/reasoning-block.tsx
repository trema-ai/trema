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

function ReasoningBlock({ redacted, children, className }: ReasoningBlockProps) {
  if (redacted) {
    return (
      <div
        data-slot="reasoning-block"
        data-redacted="true"
        className={cn("flex items-center gap-1.5 text-meta text-muted-foreground", className)}
      >
        <Lock className="size-3 shrink-0" />
        Reasoning (redacted)
      </div>
    );
  }

  return (
    <Collapsible data-slot="reasoning-block" className={className}>
      <CollapsibleTrigger className="group flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        Reasoning
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1.5 border-l-2 pl-3 text-meta text-muted-foreground">{children}</div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export { ReasoningBlock, type ReasoningBlockProps };
