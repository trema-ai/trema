import { ChevronRight } from "lucide-react";
import type * as React from "react";

import { StatusDot } from "#web/components/trema/status-dot.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import { cn } from "#web/lib/utils.ts";

type ActivityState = "running" | "ok" | "error" | "denied";

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

/**
 * One tool call as a machinery row: muted, one line collapsed, detail behind
 * a left rule when expanded. Success stays quiet — only running, denied, and
 * error states carry a marker, so a clean run reads as plain activity, not a
 * wall of green. Detail content is unmounted while closed, so anything lazy
 * inside `children` loads on first expand.
 */
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
  const expandable =
    input !== undefined || notes !== undefined || kind !== undefined || children !== undefined;

  const row = (
    <>
      <span className="flex min-w-0 items-baseline gap-2 text-chrome text-muted-foreground">
        <span className="shrink-0 group-hover:text-foreground">{title}</span>
        {resultSummary !== undefined && (
          <span
            className={cn(
              "truncate text-meta group-data-[state=open]:hidden",
              // A refusal marks itself: the denial text carries the color.
              state === "denied" && "text-destructive",
            )}
          >
            {resultSummary}
          </span>
        )}
      </span>
      {(state === "running" || state === "error") && (
        <span
          className={cn(
            "flex shrink-0 items-center gap-1.5 pl-2 text-meta",
            state === "running" ? "text-muted-foreground" : "text-destructive",
          )}
        >
          {state}
          <StatusDot tone={state === "running" ? "run" : "destructive"} />
        </span>
      )}
    </>
  );

  if (!expandable) {
    return (
      <div data-slot="activity-card" className={cn("flex items-center gap-2 py-0.5", className)}>
        <span className="size-3 shrink-0" />
        {row}
      </div>
    );
  }

  return (
    <Collapsible data-slot="activity-card" className={className}>
      <CollapsibleTrigger className="group -mx-1.5 flex w-full items-center gap-2 rounded-sm px-1.5 py-0.5 text-left hover:bg-muted/50">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        {row}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1.5 ml-[5px] space-y-2 border-l pl-4">
          {kind !== undefined && (
            <div className="font-mono text-meta text-muted-foreground">{kind}</div>
          )}
          {input !== undefined && (
            <div className="rounded-sm bg-muted px-2 py-1.5 font-mono text-log break-all">
              {input}
            </div>
          )}
          {notes !== undefined && <p className="text-meta text-muted-foreground">{notes}</p>}
          {resultSummary !== undefined && (
            <p className={cn("text-meta", state === "denied" && "text-destructive")}>
              {resultSummary}
            </p>
          )}
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export { ActivityCard, type ActivityCardProps, type ActivityState };
