import type { ReactNode } from "react";
import {
  type CredentialStatus,
  CredentialStatusBadge,
} from "#web/components/trema/credential-status-badge.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Card, CardAction, CardContent, CardHeader, CardTitle } from "#web/components/ui/card.tsx";
import {
  type CatalogProvider,
  categoryLabel,
  providerLogo,
} from "#web/pages/settings/connectors/shared.tsx";

type ConnectorCardAction = {
  label: string;
  onClick: () => void;
  icon?: ReactNode;
  variant?: "default" | "outline" | "destructive";
  disabled?: boolean;
};

type ConnectorCardIdentity = { kind: "personal"; accountLabel: string } | { kind: "organization" };

export function ConnectorCard({
  provider,
  status,
  action,
  identity,
  detail,
  footer,
  onOpen,
}: {
  provider: CatalogProvider;
  status?: { value: CredentialStatus; label: string } | undefined;
  action?: ConnectorCardAction | undefined;
  identity?: ConnectorCardIdentity | undefined;
  detail?: ReactNode;
  footer?: ReactNode;
  onOpen?: (() => void) | undefined;
}) {
  const hasContent = Boolean(identity || detail || footer);

  return (
    <Card
      data-slot="connector-card"
      className={`gap-2 py-4 shadow-xs${onOpen ? " cursor-pointer transition-colors hover:bg-muted/40" : ""}`}
      onClick={onOpen}
    >
      <CardHeader className="gap-y-0 px-4">
        <div className="flex items-center gap-2">
          {providerLogo(provider)}
          <div className="min-w-0">
            <CardTitle>{provider.displayName}</CardTitle>
            <p className="mt-0.5 text-meta text-muted-foreground">
              {categoryLabel(provider.categories)}
            </p>
          </div>
        </div>
        {action || status ? (
          <CardAction className="self-center">
            {action ? (
              <Button
                size="xs"
                variant={action.variant ?? "outline"}
                disabled={action.disabled}
                onClick={(event) => {
                  event.stopPropagation();
                  action.onClick();
                }}
              >
                {action.icon}
                {action.label}
              </Button>
            ) : status ? (
              <CredentialStatusBadge status={status.value} label={status.label} />
            ) : null}
          </CardAction>
        ) : null}
      </CardHeader>
      {hasContent ? (
        <CardContent className="space-y-2 px-4">
          {identity ? (
            <p className="text-meta text-muted-foreground">
              {identity.kind === "personal" ? (
                <>Connected as you · {identity.accountLabel}</>
              ) : (
                "Provided by your organization"
              )}
            </p>
          ) : null}
          {detail ? <div className="text-meta text-muted-foreground">{detail}</div> : null}
          {footer ? <div className="flex flex-wrap items-center gap-2 pt-1">{footer}</div> : null}
        </CardContent>
      ) : null}
    </Card>
  );
}
