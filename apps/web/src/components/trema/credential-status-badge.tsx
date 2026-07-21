import type * as React from "react";

import { StatusDot } from "#/components/trema/status-dot.tsx";
import { cn } from "#/lib/utils.ts";

type CredentialStatus = "connected" | "missing" | "expired";

const statusTone: Record<CredentialStatus, "go" | "wait" | "destructive"> = {
  connected: "go",
  missing: "wait",
  expired: "destructive",
};

type CredentialStatusBadgeProps = React.ComponentProps<"span"> & { status: CredentialStatus };

function CredentialStatusBadge({ status, className, ...props }: CredentialStatusBadgeProps) {
  return (
    <span
      data-slot="credential-status-badge"
      data-status={status}
      className={cn("inline-flex items-center gap-1.5 text-chrome capitalize", className)}
      {...props}
    >
      <StatusDot tone={statusTone[status]} />
      {status}
    </span>
  );
}

export { type CredentialStatus, CredentialStatusBadge, type CredentialStatusBadgeProps };
