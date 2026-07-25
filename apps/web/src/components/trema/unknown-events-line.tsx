import { cn } from "#web/lib/utils.ts";

type UnknownEventsLineProps = {
  count: number;
  className?: string;
};

function UnknownEventsLine({ count, className }: UnknownEventsLineProps) {
  if (count === 0) {
    return null;
  }

  return (
    <div
      data-slot="unknown-events-line"
      className={cn("text-center text-meta text-muted-foreground", className)}
    >
      {count} unrecognized event{count === 1 ? "" : "s"}
    </div>
  );
}

export { UnknownEventsLine, type UnknownEventsLineProps };
