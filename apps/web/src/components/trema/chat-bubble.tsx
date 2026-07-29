import type * as React from "react";

import { cn } from "#web/lib/utils.ts";

type ChatBubbleProps = {
  children: React.ReactNode;
  queued?: boolean;
  className?: string;
  /** Identifies projection bubbles without changing the shared visual slot. */
  part?: "steering";
};

function ChatBubble({ children, queued = false, className, part }: ChatBubbleProps) {
  return (
    <div className={cn("flex w-full flex-col items-end", className)}>
      <div
        data-slot="chat-bubble"
        {...(part === undefined ? {} : { "data-chat-part": part })}
        className="ml-[72px] max-w-[calc(100%_-_72px)] rounded-xl bg-muted px-4 py-2"
      >
        <p className="text-chat break-words whitespace-pre-wrap">{children}</p>
      </div>
      {queued && <p className="mt-1 text-right text-meta text-muted-foreground">Queued</p>}
    </div>
  );
}

export { ChatBubble, type ChatBubbleProps };
