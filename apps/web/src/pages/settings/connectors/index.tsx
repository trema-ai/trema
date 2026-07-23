import { useQuery } from "@tanstack/react-query";
import { Cable } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { CredentialStatusBadge } from "#/components/trema/credential-status-badge.tsx";
import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { orpc } from "#/lib/api.ts";
import { StaticConnectionDialog } from "#/pages/settings/connectors/connection-dialogs.tsx";
import { RegistrationDialog } from "#/pages/settings/connectors/registration-dialog.tsx";
import {
  type CatalogProvider,
  type ConnectorConnection,
  type ConnectorInstallation,
  type ConnectorMeta,
  providerLogo,
  type Registration,
} from "#/pages/settings/connectors/shared.tsx";

type ProviderRow = {
  provider: CatalogProvider;
  connections: ConnectorConnection[];
  installations: ConnectorInstallation[];
  needsSetup: boolean;
};

function status(row: ProviderRow) {
  if (row.needsSetup) return { status: "missing" as const, label: "Needs setup" };
  if (row.connections.length === 0) return { status: "missing" as const, label: "Not connected" };
  if (row.connections.some((connection) => connection.isValid)) {
    return { status: "connected" as const, label: "Connected" };
  }
  return { status: "expired" as const, label: "Reconnect needed" };
}

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
  const columns: DataTableColumn<ProviderRow>[] = [
    {
      key: "connector",
      header: "Connector",
      render: ({ provider }) => (
        <div className="flex items-center gap-2.5">
          {providerLogo(provider, "size-8")}
          <span className="font-medium">{provider.displayName}</span>
        </div>
      ),
    },
    {
      key: "status",
      header: "Status",
      render: (row) => <CredentialStatusBadge {...status(row)} />,
    },
    {
      key: "connections",
      header: "Connections",
      render: (row) => row.connections.length,
    },
    {
      key: "scopes",
      header: "Scopes",
      render: (row) => row.installations.length,
    },
  ];
  const error =
    catalog.error ?? connections.error ?? installations.error ?? registrations.error ?? meta.error;

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
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(row) => row.provider.key}
        onRowClick={open}
        loading={
          catalog.isPending ||
          connections.isPending ||
          installations.isPending ||
          registrations.isPending ||
          meta.isPending
        }
        empty={
          <EmptyState
            icon={Cable}
            title="No connector providers"
            description="No providers are available in the connector catalog."
          />
        }
      />
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
          onConnected={(connectionId) => {
            const key = staticProvider.key;
            setStaticProvider(undefined);
            navigate(`/settings/connectors/${key}?connected=${connectionId}`);
          }}
        />
      ) : null}
    </main>
  );
}
