import { CircleCheck, CircleHelp, CircleX, Clock, Loader2Icon } from "lucide-react";

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
  /** Connector identity for a live approval, when the gated call supplies it. */
  connector?: {
    name: string;
    logoUrl?: string;
    account?: {
      label?: string;
      source: "personal" | "organization";
    };
  };
  /** Provenance for card surfaces; omit where the context already says it. */
  requestedBy?: string;
  prompt?: string;
  options: ApprovalOption[];
  runHref?: string;
  expiresAt?: Date | string;
  resolution?: ApprovalResolution;
  onResolve?: (optionId: string) => void;
  /**
   * The option whose decision is in flight: its button shows a spinner and
   * the whole group disables. The caller keeps this set until the resolution
   * event arrives — the card never flips to resolved from a response.
   */
  pendingOptionId?: string;
  /** A failed submit, stated inline below the options, which stay live. */
  error?: string;
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
  connector,
  requestedBy,
  prompt,
  options,
  runHref,
  expiresAt,
  resolution,
  onResolve,
  pendingOptionId,
  error,
  disabledReason,
  className,
}: ApprovalCardProps) {
  const requestLabel =
    kind === "approval"
      ? "Permission required"
      : kind === "confirmation"
        ? "Confirmation required"
        : "Input required";

  return (
    <div
      data-slot="approval-card"
      data-kind={kind}
      className={cn("rounded-md border bg-card p-4", className)}
    >
      <div className="mb-2 flex items-center justify-between gap-3 text-meta font-medium text-muted-foreground">
        <span className="flex items-center gap-1.5">
          <CircleHelp className="size-3.5" aria-hidden="true" />
          <span>{requestLabel}</span>
        </span>
        {connector !== undefined && (
          <span className="flex min-w-0 items-center gap-1.5 text-foreground">
            {connector.logoUrl !== undefined ? (
              <img
                src={connector.logoUrl}
                alt=""
                className="size-5 shrink-0 rounded-sm border object-contain p-0.5"
              />
            ) : (
              <span
                className="grid size-5 shrink-0 place-items-center rounded-sm border bg-muted text-[10px]"
                aria-hidden="true"
              >
                {connector.name.slice(0, 1)}
              </span>
            )}
            <span className="truncate">{connector.name}</span>
          </span>
        )}
      </div>

      {/* What is being asked, and why it paused — the two glance signals. */}
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 text-[15px] leading-snug font-semibold">{headline}</div>
        {action !== undefined && <ModeBadge mode={action.mode} className="mt-0.5 shrink-0" />}
      </div>

      {prompt !== undefined && <p className="mt-1.5 text-chrome text-muted-foreground">{prompt}</p>}

      {connector?.account !== undefined && (
        <p className="mt-2 text-meta text-muted-foreground">
          {connector.account.label !== undefined
            ? `Using ${connector.account.label}`
            : connector.account.source === "personal"
              ? "Using your connected account"
              : "Using an organization-provided account"}
        </p>
      )}

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
      <div className="mt-3.5 flex items-center justify-between gap-3">
        {resolution !== undefined ? (
          <ResolutionLine resolution={resolution} />
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {options.map((option) => (
              <Button
                key={option.id}
                type="button"
                size="sm"
                disabled={disabledReason !== undefined || pendingOptionId !== undefined}
                variant={option.variant === "primary" ? "default" : "outline"}
                className={cn(
                  option.variant === "destructive" && "text-destructive hover:text-destructive",
                )}
                onClick={() => onResolve?.(option.id)}
              >
                {pendingOptionId === option.id && <Loader2Icon className="animate-spin" />}
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

      {resolution === undefined && error !== undefined && (
        <p className="mt-2 text-meta text-destructive">{error}</p>
      )}

      {/* Provenance footer: who asked, where to dig. Absent when the
          surrounding page already answers both. */}
      {(requestedBy !== undefined || runHref !== undefined) && (
        <div className="mt-3 flex items-center justify-between gap-3 border-t pt-2.5 text-meta text-muted-foreground">
          {requestedBy !== undefined && (
            <span className="min-w-0 truncate">requested by {requestedBy}</span>
          )}
          {runHref !== undefined && (
            <a href={runHref} className="ml-auto shrink-0 text-moss hover:underline">
              View run →
            </a>
          )}
        </div>
      )}
    </div>
  );
}

export { ApprovalCard, type ApprovalCardProps, type ApprovalOption, type ApprovalResolution };
