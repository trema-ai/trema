import { CircleX } from "lucide-react";

import { cn } from "#web/lib/utils.ts";

type ErrorItemProps = {
  title: string;
  message: string;
  stopReason?: string;
  className?: string;
};

/**
 * An error as a machinery row. The destructive color marks it; the type stays
 * at machinery size so an error never shouts over the conversation.
 */
function ErrorItem({ title, message, stopReason, className }: ErrorItemProps) {
  return (
    <div data-slot="error-item" className={cn("flex items-baseline gap-2 py-0.5", className)}>
      <CircleX className="size-3 shrink-0 self-center text-destructive" />
      <span className="shrink-0 text-chrome text-destructive">{title}</span>
      <span className="min-w-0 font-mono text-meta text-muted-foreground break-all">{message}</span>
      {stopReason !== undefined && (
        <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-meta text-muted-foreground">
          {stopReason}
        </span>
      )}
    </div>
  );
}

export { ErrorItem, type ErrorItemProps };
