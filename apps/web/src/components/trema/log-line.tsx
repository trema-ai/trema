import { cn } from "#web/lib/utils.ts";

type LogLevel = "info" | "warn" | "error";

const levelClasses: Record<LogLevel, string> = {
  info: "",
  warn: "bg-wait-soft",
  error: "bg-destructive-soft",
};

type LogLineProps = {
  level: LogLevel;
  timestamp: Date | string;
  message: string;
  className?: string;
};

function formatTimestamp(timestamp: Date | string): string {
  if (typeof timestamp === "string") {
    return timestamp;
  }
  return timestamp.toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function LogLine({ level, timestamp, message, className }: LogLineProps) {
  return (
    <div
      data-slot="log-line"
      data-level={level}
      className={cn(
        "flex w-full gap-3 px-2 font-mono text-log hover:bg-muted",
        levelClasses[level],
        className,
      )}
    >
      <span className="shrink-0 text-muted-foreground">{formatTimestamp(timestamp)}</span>
      <span className="min-w-0 flex-1 break-all whitespace-pre-wrap">{message}</span>
    </div>
  );
}

export { type LogLevel, LogLine, type LogLineProps };
