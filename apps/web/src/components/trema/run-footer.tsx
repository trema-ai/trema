import type * as React from "react";
import { useEffect, useState } from "react";
import { Link } from "react-router";

import { CopyButton } from "#web/components/trema/copy-button.tsx";
import { StatusDot } from "#web/components/trema/status-dot.tsx";
import { formatDuration } from "#web/lib/run-timeline.ts";
import { cn } from "#web/lib/utils.ts";

type RunFooterProps = {
  runId: string;
  /** When the run started. An ISO 8601 date-time. */
  startedAt: string;
  /** When the run's last event landed; omitted while the run is live. */
  endedAt?: string;
  live?: boolean;
  /** A live run parked on a human decision does not keep a working timer. */
  waitingForDecision?: boolean;
  /** The stop control, rendered beside the working indicator while live. */
  stop?: React.ReactNode;
  /** Assistant prose copied from this run; omitted when the run produced none. */
  copyText?: string;
  className?: string;
};

/** Elapsed time since `from`, ticking once a second while `active`. */
export function useElapsed(from: string, active: boolean): string {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1_000);
    return () => clearInterval(timer);
  }, [active]);
  const start = Date.parse(from);
  return formatDuration(Number.isFinite(start) ? now - start : 0);
}

/**
 * The line that closes a chat run block: the worked-for duration is itself
 * the deep link to the canonical run view — the run's record earns the
 * clickthrough, not a separate button. While the run is live the same slot
 * is the working indicator with live elapsed time, with the stop control
 * riding beside it exactly as long as there is something to stop.
 */
function RunFooter({
  runId,
  startedAt,
  endedAt,
  live = false,
  waitingForDecision = false,
  stop,
  copyText,
  className,
}: RunFooterProps) {
  const elapsed = useElapsed(startedAt, live && !waitingForDecision);

  if (live) {
    return (
      <div
        data-slot="run-footer"
        className={cn("flex items-center gap-1.5 text-meta text-muted-foreground", className)}
      >
        <StatusDot tone={waitingForDecision ? "wait" : "run"} />
        <Link to={`/runs/${runId}`} className="hover:text-foreground hover:underline">
          {waitingForDecision ? "Paused · Waiting for your decision" : `Working for ${elapsed}`}
        </Link>
        {stop}
      </div>
    );
  }

  const started = Date.parse(startedAt);
  const ended = endedAt === undefined ? Number.NaN : Date.parse(endedAt);
  const workedFor =
    Number.isFinite(started) && Number.isFinite(ended) && ended >= started
      ? formatDuration(ended - started)
      : undefined;

  return (
    <div
      data-slot="run-footer"
      className={cn("flex items-center gap-1 text-meta text-muted-foreground", className)}
    >
      <Link to={`/runs/${runId}`} className="hover:text-foreground hover:underline">
        {workedFor === undefined ? "View run" : `Worked for ${workedFor}`}
      </Link>
      {copyText ? <CopyButton value={copyText} className="-my-1 size-7" /> : null}
    </div>
  );
}

export { RunFooter, type RunFooterProps };
