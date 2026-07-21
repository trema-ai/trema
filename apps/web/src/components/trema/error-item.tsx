import { CircleX } from "lucide-react";

import { cn } from "#/lib/utils.ts";

type ErrorItemProps = {
  title: string;
  message: string;
  stopReason?: string;
  className?: string;
};

function ErrorItem({ title, message, stopReason, className }: ErrorItemProps) {
  return (
    <div
      data-slot="error-item"
      className={cn("rounded-md border border-destructive/35 bg-card p-3", className)}
    >
      <div className="flex items-center gap-2">
        <CircleX className="size-3.5 shrink-0 text-destructive" />
        <span className="text-chrome font-medium text-destructive">{title}</span>
        {stopReason !== undefined && (
          <span className="ml-auto shrink-0 rounded-sm bg-muted px-1.5 py-0.5 font-mono text-meta text-muted-foreground">
            {stopReason}
          </span>
        )}
      </div>
      <div className="mt-2 rounded-sm bg-muted px-2 py-1.5 font-mono text-log break-all">
        {message}
      </div>
    </div>
  );
}

export { ErrorItem, type ErrorItemProps };
