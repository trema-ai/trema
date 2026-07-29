import { ChevronDown } from "lucide-react";
import { useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import { cn } from "#web/lib/utils.ts";

type ChainOfThoughtProps = {
  streaming: boolean;
  /** The run's worked-for duration; when set, the settled label carries it. */
  workedFor?: string;
  /** The run's ticking elapsed time; when set, the streaming label carries it. */
  workingFor?: string;
  children: React.ReactNode;
};

export function disclosureOpen(userOpen: boolean | null, streaming: boolean): boolean {
  return userOpen ?? streaming;
}

export function chainOfThoughtLabel(
  streaming: boolean,
  workedFor?: string,
  workingFor?: string,
): string {
  if (streaming) return workingFor === undefined ? "Working…" : `Working for ${workingFor}`;
  return workedFor === undefined ? "Worked it out" : `Worked for ${workedFor}`;
}

/**
 * One interleaved machinery burst. Live work stays visible until it settles;
 * after the first manual toggle, the reader's choice owns the disclosure.
 */
export function ChainOfThought({
  streaming,
  workedFor,
  workingFor,
  children,
}: ChainOfThoughtProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = disclosureOpen(userOpen, streaming);

  return (
    <Collapsible
      data-slot="chain-of-thought"
      open={open}
      onOpenChange={setUserOpen}
      className="group/chain w-full"
      style={{ "--animation-duration": "200ms" } as React.CSSProperties}
    >
      <CollapsibleTrigger
        data-slot="chain-of-thought-trigger"
        className="group/trigger flex origin-left items-center gap-2 py-1.5 text-sm text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]"
      >
        <span
          className={cn(
            "leading-none tabular-nums",
            streaming && "shimmer motion-reduce:animate-none",
          )}
        >
          {chainOfThoughtLabel(streaming, workedFor, workingFor)}
        </span>
        {!streaming && (
          <ChevronDown
            className={cn(
              "mt-0.5 size-3 shrink-0",
              "transition-transform duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:transition-none",
              "group-data-[state=closed]/trigger:-rotate-90",
              "group-data-[state=open]/trigger:rotate-0",
            )}
          />
        )}
      </CollapsibleTrigger>
      <CollapsibleContent
        data-slot="chain-of-thought-content"
        className={cn(
          "relative overflow-hidden outline-none",
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-[state=closed]:animate-collapsible-up",
          "data-[state=open]:animate-collapsible-down",
          "data-[state=closed]:pointer-events-none data-[state=closed]:fill-mode-forwards",
          "data-[state=closed]:duration-(--animation-duration)",
          "data-[state=open]:duration-(--animation-duration)",
        )}
      >
        <div className="mt-1 ms-1 flex flex-col gap-1 border-s border-muted-foreground/20 ps-3">
          {children}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

export type { ChainOfThoughtProps };
