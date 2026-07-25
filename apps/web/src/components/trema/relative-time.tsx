import type * as React from "react";

import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#web/components/ui/tooltip.tsx";
import { cn } from "#web/lib/utils.ts";

function formatRelative(date: Date): string {
  const diffSeconds = Math.round((date.getTime() - Date.now()) / 1000);
  const abs = Math.abs(diffSeconds);

  let text: string;
  if (abs < 60) {
    text = `${abs}s`;
  } else if (abs < 3600) {
    text = `${Math.round(abs / 60)}m`;
  } else if (abs < 86400) {
    text = `${Math.round(abs / 3600)}h`;
  } else {
    text = `${Math.round(abs / 86400)}d`;
  }

  return diffSeconds <= 0 ? `${text} ago` : `in ${text}`;
}

type RelativeTimeProps = Omit<React.ComponentProps<"time">, "dateTime"> & {
  date: Date | string;
};

function RelativeTime({ date, className, ...props }: RelativeTimeProps) {
  const parsed = typeof date === "string" ? new Date(date) : date;

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <time
            data-slot="relative-time"
            dateTime={parsed.toISOString()}
            className={cn("text-meta text-muted-foreground", className)}
            {...props}
          >
            {formatRelative(parsed)}
          </time>
        </TooltipTrigger>
        <TooltipContent>{parsed.toLocaleString()}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export { RelativeTime, type RelativeTimeProps };
