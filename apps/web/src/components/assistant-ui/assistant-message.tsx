import { MessagePartPrimitive, MessagePrimitive } from "@assistant-ui/react";

import { MessageActionBar } from "#/components/assistant-ui/action-bar.tsx";
import { MarkdownText } from "#/components/assistant-ui/markdown-text.tsx";

/* Subtle pulsing dot shown while the assistant is still writing. */
function StreamingDot() {
  return (
    <span
      role="status"
      aria-label="Assistant is responding"
      className="mx-0.5 inline-block size-2 animate-pulse rounded-full bg-muted-foreground"
    />
  );
}

/* Markdown text plus the streaming dot while the part is in progress. */
function AssistantText() {
  return (
    <>
      <MarkdownText />
      <MessagePartPrimitive.InProgress>
        <StreamingDot />
      </MessagePartPrimitive.InProgress>
    </>
  );
}

/*
 * Assistant messages are plain text on the surface: no bubble, full
 * column width. The action bar below fades in on hover.
 */
function AssistantMessage() {
  return (
    <MessagePrimitive.Root data-slot="assistant-message" className="group/message w-full text-chat">
      <MessagePrimitive.Parts components={{ Text: AssistantText, Empty: StreamingDot }} />
      <MessageActionBar />
    </MessagePrimitive.Root>
  );
}

export { AssistantMessage };
