import { ChevronRight, Wrench } from "lucide-react";
import type * as React from "react";

import { StatusDot } from "#web/components/trema/status-dot.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import { cn } from "#web/lib/utils.ts";

type ActivityState = "running" | "ok" | "error" | "denied";

const stateTone: Record<ActivityState, "run" | "go" | "destructive"> = {
  running: "run",
  ok: "go",
  error: "destructive",
  denied: "destructive",
};

type ActivityCardProps = {
  title: string;
  kind?: string;
  input?: string;
  notes?: string;
  resultSummary?: string;
  state?: ActivityState;
  children?: React.ReactNode;
  className?: string;
};

function ActivityCard({
  title,
  kind,
  input,
  notes,
  resultSummary,
  state,
  children,
  className,
}: ActivityCardProps) {
  return (
    <div
      data-slot="activity-card"
      className={cn("rounded-md border bg-card px-3 py-2.5", className)}
    >
      <div className="flex items-center gap-2">
        <Wrench className="size-3.5 shrink-0 text-muted-foreground" />
        <span className="flex min-w-0 items-baseline gap-2">
          <span className="text-chrome font-medium">{title}</span>
          {kind !== undefined && (
            <span className="truncate font-mono text-meta text-muted-foreground">{kind}</span>
          )}
        </span>
        {state !== undefined && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5">
            {/* Denied is not an error: the call was refused, so the dot alone
                would read as a failure. The word makes the refusal explicit. */}
            {state === "denied" && <span className="text-meta text-destructive">denied</span>}
            <StatusDot tone={stateTone[state]} />
          </span>
        )}
      </div>

      {input !== undefined && (
        <div className="mt-2 rounded-sm bg-muted px-2 py-1.5 font-mono text-log break-all">
          {input}
        </div>
      )}
      {notes !== undefined && <p className="mt-1.5 text-meta text-muted-foreground">{notes}</p>}
      {resultSummary !== undefined && <p className="mt-1.5 text-meta">{resultSummary}</p>}

      {children !== undefined && (
        <Collapsible className="mt-2">
          <CollapsibleTrigger className="group flex items-center gap-1 text-meta text-muted-foreground hover:text-foreground">
            <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
            Show output
          </CollapsibleTrigger>
          <CollapsibleContent>
            <div className="mt-2">{children}</div>
          </CollapsibleContent>
        </Collapsible>
      )}
    </div>
  );
}

export { ActivityCard, type ActivityCardProps, type ActivityState };
