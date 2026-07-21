import { AuiIf, ThreadPrimitive } from "@assistant-ui/react";
import { ArrowDown } from "lucide-react";

import { AssistantMessage } from "#/components/assistant-ui/assistant-message.tsx";
import { Composer } from "#/components/assistant-ui/composer.tsx";
import { UserMessage } from "#/components/assistant-ui/user-message.tsx";
import { Button } from "#/components/ui/button.tsx";

/*
 * The full chat surface: a centered 740px reading column on the card
 * background, with the composer stuck to the bottom of the column and a
 * scroll-to-bottom button floating above it.
 */
function Thread() {
  return (
    <ThreadPrimitive.Root
      data-slot="thread"
      className="flex h-full flex-col overflow-hidden bg-card"
    >
      <ThreadPrimitive.Viewport
        autoScroll
        className="relative flex flex-1 flex-col overflow-y-auto"
      >
        <div className="mx-auto flex w-full max-w-[740px] flex-1 flex-col gap-5 px-4 pt-8 pb-4">
          <AuiIf condition={(s) => s.thread.isEmpty}>
            <div className="flex flex-1 items-center justify-center">
              <p className="text-chat text-muted-foreground">How can I help?</p>
            </div>
          </AuiIf>
          <ThreadPrimitive.Messages components={{ UserMessage, AssistantMessage }} />
        </div>
        <div className="sticky bottom-0 mx-auto w-full max-w-[740px] bg-card px-4 pb-4">
          <div className="relative">
            <ThreadPrimitive.ScrollToBottom asChild>
              <Button
                size="icon-sm"
                aria-label="Scroll to bottom"
                className="absolute -top-11 left-1/2 size-8 -translate-x-1/2 rounded-full border bg-card text-muted-foreground shadow-overlay hover:bg-muted disabled:invisible"
              >
                <ArrowDown className="size-4" />
              </Button>
            </ThreadPrimitive.ScrollToBottom>
            <Composer />
          </div>
        </div>
      </ThreadPrimitive.Viewport>
    </ThreadPrimitive.Root>
  );
}

export { Thread };
