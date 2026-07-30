import { ChevronDown, Lock } from "lucide-react";
import type * as React from "react";
import { useEffect, useRef, useState } from "react";

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import { cn } from "#web/lib/utils.ts";

type ReasoningBlockProps = {
  redacted?: boolean;
  streaming?: boolean;
  children?: React.ReactNode;
  className?: string;
};

/** Reasoning as a machinery row; a redacted block shows presence, never content. */
function ReasoningBlock({ redacted, streaming = false, children, className }: ReasoningBlockProps) {
  const [userOpen, setUserOpen] = useState<boolean | null>(null);
  const open = userOpen ?? streaming;
  const preview = streaming && open && userOpen === null;
  const scrollRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!preview) return;
    const scroll = scrollRef.current;
    const content = contentRef.current;
    if (scroll === null || content === null) return;
    const pin = () => {
      scroll.scrollTop = scroll.scrollHeight;
    };
    pin();
    const observer = new ResizeObserver(pin);
    observer.observe(content);
    return () => observer.disconnect();
  }, [preview]);

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
    <Collapsible
      data-slot="reasoning-block"
      open={open}
      onOpenChange={setUserOpen}
      className={cn("group/reasoning w-full", className)}
      style={{ "--animation-duration": "200ms" } as React.CSSProperties}
    >
      <CollapsibleTrigger
        data-slot="reasoning-trigger"
        className="group/trigger flex origin-left items-center gap-2 py-1.5 text-muted-foreground transition-[color,scale] hover:text-foreground active:scale-[0.98]"
      >
        <span className="relative inline-block text-sm leading-none">
          <span>Thought for a bit</span>
          {streaming && (
            <span
              aria-hidden
              className="pointer-events-none absolute inset-0 shimmer motion-reduce:animate-none"
            >
              Thinking
            </span>
          )}
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
        data-slot="reasoning-content"
        aria-busy={streaming}
        className={cn(
          "group/content relative overflow-hidden outline-none",
          "ease-[cubic-bezier(0.32,0.72,0,1)] motion-reduce:animate-none",
          "data-[state=closed]:animate-collapsible-up",
          "data-[state=open]:animate-collapsible-down",
          "data-[state=closed]:pointer-events-none data-[state=closed]:fill-mode-forwards",
          "data-[state=closed]:duration-(--animation-duration)",
          "data-[state=open]:duration-(--animation-duration)",
        )}
      >
        {preview && (
          <div className="pointer-events-none absolute inset-x-0 top-0 z-10 h-8 animate-in bg-[linear-gradient(to_bottom,var(--color-card),transparent)] duration-(--animation-duration) motion-reduce:animate-none" />
        )}
        <div
          ref={scrollRef}
          className={cn(
            "relative z-0 max-h-64 overflow-y-auto pt-1 pb-1 text-meta text-muted-foreground",
            "transition-[transform,opacity] duration-(--animation-duration) ease-[cubic-bezier(0.32,0.72,0,1)]",
            "group-data-[state=open]/content:animate-in group-data-[state=open]/content:fade-in-0 group-data-[state=open]/content:slide-in-from-top-1",
            "motion-reduce:animate-none",
          )}
        >
          <div ref={contentRef} className="italic">
            {children}
          </div>
        </div>
        {preview && (
          <div className="pointer-events-none absolute inset-x-0 bottom-0 z-10 h-8 animate-in bg-[linear-gradient(to_top,var(--color-card),transparent)] duration-(--animation-duration) motion-reduce:animate-none" />
        )}
      </CollapsibleContent>
    </Collapsible>
  );
}

export { ReasoningBlock, type ReasoningBlockProps };
