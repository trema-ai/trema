import { AuiIf, ComposerPrimitive } from "@assistant-ui/react";
import { ArrowUp, Plus, Square } from "lucide-react";

import { Button } from "#web/components/ui/button.tsx";

/*
 * The default assistant-ui composer shape: a rounded shell with the input
 * on top and an action row below (attach left, send right). The send
 * button swaps to a stop button while the assistant runs.
 */
function Composer() {
  return (
    <ComposerPrimitive.Root data-slot="composer" className="relative flex w-full flex-col">
      <div className="flex w-full flex-col gap-2 rounded-3xl border border-border/60 bg-[color-mix(in_oklab,var(--muted)_30%,var(--card))] p-2 transition-colors focus-within:border-border">
        <ComposerPrimitive.Input
          placeholder="Send a message…"
          maxRows={8}
          autoFocus
          enterKeyHint="send"
          aria-label="Message input"
          className="max-h-32 min-h-10 w-full resize-none bg-transparent px-2.5 py-1 text-chat outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center justify-between">
          {/* Attach placeholder: no attachment adapter is wired up yet. */}
          <Button
            type="button"
            variant="ghost"
            size="icon-sm"
            aria-label="Attach"
            className="size-7 rounded-full text-muted-foreground"
          >
            <Plus className="size-4" />
          </Button>
          <AuiIf condition={(s) => !s.thread.isRunning}>
            <ComposerPrimitive.Send asChild>
              <Button size="icon-sm" aria-label="Send" className="size-7 rounded-full">
                <ArrowUp className="size-4" />
              </Button>
            </ComposerPrimitive.Send>
          </AuiIf>
          <AuiIf condition={(s) => s.thread.isRunning}>
            <ComposerPrimitive.Cancel asChild>
              <Button size="icon-sm" aria-label="Stop" className="size-7 rounded-full">
                <Square className="size-3 fill-current" />
              </Button>
            </ComposerPrimitive.Cancel>
          </AuiIf>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

export { Composer };
