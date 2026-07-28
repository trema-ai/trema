import { CircleCheck, CircleX, Clock } from "lucide-react";

import { type ApprovalModeValue, ModeBadge } from "#web/components/trema/mode-badge.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { cn } from "#web/lib/utils.ts";

type ApprovalOption = {
  id: string;
  label: string;
  variant?: "primary" | "secondary" | "destructive";
};

type ApprovalResolution = {
  outcome: string;
  by?: string;
  at?: Date | string;
};

type ApprovalCardProps = {
  headline: string;
  kind: "approval" | "confirmation" | "choice" | "form";
  action?: {
    toolTitle: string;
    connector: string;
    mode: ApprovalModeValue;
    /** Why a delegated-mode call paused, from the classifier. */
    escalationReason?: string;
    argsSummary: string;
  };
  requestedBy: string;
  prompt?: string;
  options: ApprovalOption[];
  runHref?: string;
  expiresAt?: Date | string;
  resolution?: ApprovalResolution;
  onResolve?: (optionId: string) => void;
  /**
   * Renders the option buttons disabled with this line explaining why —
   * for surfaces that show a pending decision they cannot yet take.
   */
  disabledReason?: string;
  className?: string;
};

function formatResolvedAt(at: Date | string): string {
  const parsed = typeof at === "string" ? new Date(at) : at;
  return parsed.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function ResolutionLine({ resolution }: { resolution: ApprovalResolution }) {
  const { outcome, by, at } = resolution;
  const Icon = outcome === "approved" ? CircleCheck : outcome === "denied" ? CircleX : Clock;
  const color =
    outcome === "approved"
      ? "text-go"
      : outcome === "denied"
        ? "text-destructive"
        : "text-muted-foreground";
  return (
    <span className={cn("flex items-center gap-1.5 text-chrome font-medium", color)}>
      <Icon className="size-4 shrink-0" />
      <span>
        <span className="capitalize">{outcome}</span>
        {by !== undefined && ` by ${by}`}
        {at !== undefined && ` · ${formatResolvedAt(at)}`}
      </span>
    </span>
  );
}

function ApprovalCard({
  headline,
  kind,
  action,
  requestedBy,
  prompt,
  options,
  runHref,
  expiresAt,
  resolution,
  onResolve,
  disabledReason,
  className,
}: ApprovalCardProps) {
  return (
    <div
      data-slot="approval-card"
      data-kind={kind}
      className={cn("rounded-md border bg-card p-4", className)}
    >
      {/* What is being asked, and why it paused — the two glance signals. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[15px] leading-snug font-semibold">{headline}</div>
        {action !== undefined && <ModeBadge mode={action.mode} className="mt-0.5 shrink-0" />}
      </div>

      {prompt !== undefined && <p className="mt-1.5 text-chrome text-muted-foreground">{prompt}</p>}

      {/* The gated call as one unit: tool, connector, args. */}
      {action !== undefined && (
        <div className="mt-3 rounded-md bg-muted/60 px-3 py-2.5">
          <div className="flex items-baseline gap-2">
            <span className="text-chrome font-medium">{action.toolTitle}</span>
            <span className="text-meta text-muted-foreground">{action.connector}</span>
          </div>
          <div className="mt-1 line-clamp-3 font-mono text-log text-muted-foreground">
            {action.argsSummary}
          </div>
          {action.escalationReason !== undefined && (
            <div className="mt-1.5 text-meta text-muted-foreground">
              Paused by the classifier: {action.escalationReason}
            </div>
          )}
        </div>
      )}

      {/* The decision row: act, or see the outcome. Urgency sits beside it. */}
      <div className="mt-4 flex items-center justify-between gap-3">
        {resolution !== undefined ? (
          <ResolutionLine resolution={resolution} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {options.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                disabled={disabledReason !== undefined}
                variant={option.variant === "primary" ? "default" : "outline"}
                className={cn(
                  option.variant === "destructive" && "text-destructive hover:text-destructive",
                )}
                onClick={() => onResolve?.(option.id)}
              >
                {option.label}
              </Button>
            ))}
          </div>
        )}
        {resolution === undefined && expiresAt !== undefined && (
          <span className="flex shrink-0 items-center gap-1 text-meta text-muted-foreground">
            <Clock className="size-3 shrink-0" />
            expires <RelativeTime date={expiresAt} />
          </span>
        )}
      </div>

      {resolution === undefined && disabledReason !== undefined && (
        <p className="mt-2 text-meta text-muted-foreground">{disabledReason}</p>
      )}

      {/* Provenance footer: who asked, where to dig. */}
      <div className="mt-3 flex items-center justify-between gap-3 border-t pt-2.5 text-meta text-muted-foreground">
        <span className="min-w-0 truncate">requested by {requestedBy}</span>
        {runHref !== undefined && (
          <a href={runHref} className="shrink-0 text-moss hover:underline">
            View run →
          </a>
        )}
      </div>
    </div>
  );
}

export { ApprovalCard, type ApprovalCardProps, type ApprovalOption, type ApprovalResolution };
