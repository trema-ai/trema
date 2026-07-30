import { useQuery } from "@tanstack/react-query";
import { Cable, Settings2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#web/components/ui/card.tsx";
import { orpc } from "#web/lib/api.ts";
import { StaticConnectionDialog } from "#web/pages/settings/connectors/connection-dialogs.tsx";
import { RegistrationDialog } from "#web/pages/settings/connectors/registration-dialog.tsx";
import {
  type CatalogProvider,
  type ConnectorConnection,
  type ConnectorInstallation,
  type ConnectorMeta,
  categoryLabel,
  providerLogo,
  type Registration,
} from "#web/pages/settings/connectors/shared.tsx";

type ProviderRow = {
  provider: CatalogProvider;
  connections: ConnectorConnection[];
  installations: ConnectorInstallation[];
  needsSetup: boolean;
};

export function SettingsConnectorsPage() {
  const navigate = useNavigate();
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const connections = useQuery(orpc.connectors.connections.list.queryOptions({ input: {} }));
  const installations = useQuery(orpc.connectors.installations.list.queryOptions({ input: {} }));
  const registrations = useQuery(orpc.connectors.registrations.list.queryOptions({}));
  const meta = useQuery(orpc.connectors.meta.queryOptions({}));
  const [registrationProvider, setRegistrationProvider] = useState<CatalogProvider>();
  const [staticProvider, setStaticProvider] = useState<CatalogProvider>();
  const providers = (catalog.data ?? []) as CatalogProvider[];
  const connectionRows = (connections.data ?? []) as ConnectorConnection[];
  const installationRows = (installations.data ?? []) as ConnectorInstallation[];
  const registrationRows = (registrations.data ?? []) as Registration[];
  const rows: ProviderRow[] = providers.map((provider) => {
    const providerConnections = connectionRows.filter(
      (connection) => connection.providerKey === provider.key,
    );
    const providerInstallations = installationRows.filter(
      (installation) => installation.catalogKey === provider.key,
    );
    const needsSetup =
      provider.authMode === "oauth2_code" &&
      !registrationRows.some(
        (registration) => registration.providerKey === provider.key && registration.isUsable,
      );
    return {
      provider,
      connections: providerConnections,
      installations: providerInstallations,
      needsSetup,
    };
  });
  const error =
    catalog.error ?? connections.error ?? installations.error ?? registrations.error ?? meta.error;
  const pending =
    catalog.isPending ||
    connections.isPending ||
    installations.isPending ||
    registrations.isPending ||
    meta.isPending;

  function open(row: ProviderRow) {
    if (row.needsSetup) {
      setRegistrationProvider(row.provider);
      return;
    }
    if (
      (row.provider.authMode === "api_key" || row.provider.authMode === "basic") &&
      row.connections.length === 0
    ) {
      setStaticProvider(row.provider);
      return;
    }
    navigate(`/settings/connectors/${row.provider.key}`);
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Connectors"
        description="Connect provider accounts and bind them into organization and shared scopes."
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((key) => (
            <div key={key} className="h-40 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <EmptyState
          icon={Cable}
          title="No connector providers"
          description="No providers are available in the connector catalog."
        />
      ) : (
        <div className="space-y-8">
          <CatalogSection
            title="Ready to connect"
            description="Connect these without further configuration."
            rows={rows.filter((row) => !row.needsSetup)}
            onOpen={open}
          />
          <CatalogSection
            title="Needs setup"
            description="Add the organization's OAuth app before connecting."
            rows={rows.filter((row) => row.needsSetup)}
            onOpen={open}
          />
        </div>
      )}
      {registrationProvider ? (
        <RegistrationDialog
          provider={registrationProvider}
          registrations={registrationRows.filter(
            (registration) => registration.providerKey === registrationProvider.key,
          )}
          callbackUrl={(meta.data as ConnectorMeta | undefined)?.callbackUrl ?? ""}
          open
          onOpenChange={(next) => {
            if (!next) setRegistrationProvider(undefined);
          }}
          onSaved={() => {
            const key = registrationProvider.key;
            setRegistrationProvider(undefined);
            navigate(`/settings/connectors/${key}`);
          }}
        />
      ) : null}
      {staticProvider ? (
        <StaticConnectionDialog
          provider={staticProvider}
          open
          onOpenChange={(next) => {
            if (!next) setStaticProvider(undefined);
          }}
          onConnected={() => {
            const key = staticProvider.key;
            setStaticProvider(undefined);
            navigate(`/settings/connectors/${key}`);
          }}
        />
      ) : null}
    </main>
  );
}

function CatalogSection({
  title,
  description,
  rows,
  onOpen,
}: {
  title: string;
  description: string;
  rows: ProviderRow[];
  onOpen: (row: ProviderRow) => void;
}) {
  if (rows.length === 0) return null;
  return (
    <section>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {rows.map((row) => (
          <ProviderCard key={row.provider.key} row={row} onOpen={() => onOpen(row)} />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({ row, onOpen }: { row: ProviderRow; onOpen: () => void }) {
  const { provider } = row;
  const counts = [
    row.connections.length > 0
      ? `${row.connections.length} connection${row.connections.length === 1 ? "" : "s"}`
      : undefined,
    row.installations.length > 0
      ? `${row.installations.length} scope${row.installations.length === 1 ? "" : "s"}`
      : undefined,
  ].filter(Boolean);
  return (
    <Card
      className="cursor-pointer gap-2 py-4 shadow-xs transition-colors hover:bg-muted/40"
      onClick={onOpen}
    >
      <CardHeader className="px-4">
        <div className="flex items-center gap-2">
          {providerLogo(provider)}
          <div className="min-w-0">
            <CardTitle>{provider.displayName}</CardTitle>
            <p className="mt-0.5 text-meta text-muted-foreground">
              {categoryLabel(provider.categories)}
            </p>
          </div>
        </div>
        {row.needsSetup ? (
          <CardAction>
            <Button
              size="xs"
              variant="outline"
              onClick={(event) => {
                event.stopPropagation();
                onOpen();
              }}
            >
              <Settings2 />
              Setup
            </Button>
          </CardAction>
        ) : null}
      </CardHeader>
      <CardContent className="px-4">
        <CardDescription>{provider.description ?? "No description available."}</CardDescription>
        {counts.length > 0 ? (
          <p className="mt-2 text-meta text-muted-foreground">{counts.join(" · ")}</p>
        ) : null}
      </CardContent>
    </Card>
  );
}
