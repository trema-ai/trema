import { ActionBarPrimitive } from "@assistant-ui/react";
import { Check, Copy, RefreshCw } from "lucide-react";

import { Button } from "#web/components/ui/button.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#web/components/ui/tooltip.tsx";

/*
 * Ghost icon row under an assistant message. Hidden until the message is
 * hovered (the message root carries the `group/message` class) or a
 * button inside it has focus.
 */
function MessageActionBar() {
  return (
    <TooltipProvider>
      <ActionBarPrimitive.Root
        hideWhenRunning
        autohide="never"
        data-slot="message-action-bar"
        className="mt-1.5 flex items-center gap-1 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/message:opacity-100"
      >
        <Tooltip>
          <TooltipTrigger asChild>
            <ActionBarPrimitive.Copy asChild copiedDuration={1500}>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Copy message"
                className="group/copy size-7 text-muted-foreground"
              >
                <Copy className="size-4 group-data-[copied]/copy:hidden" />
                <Check className="hidden size-4 text-go group-data-[copied]/copy:block" />
              </Button>
            </ActionBarPrimitive.Copy>
          </TooltipTrigger>
          <TooltipContent>Copy</TooltipContent>
        </Tooltip>
        <Tooltip>
          <TooltipTrigger asChild>
            <ActionBarPrimitive.Reload asChild>
              <Button
                variant="ghost"
                size="icon"
                aria-label="Regenerate response"
                className="size-7 text-muted-foreground"
              >
                <RefreshCw className="size-4" />
              </Button>
            </ActionBarPrimitive.Reload>
          </TooltipTrigger>
          <TooltipContent>Regenerate</TooltipContent>
        </Tooltip>
      </ActionBarPrimitive.Root>
    </TooltipProvider>
  );
}

export { MessageActionBar };
