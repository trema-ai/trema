import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, Settings2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { orpc } from "#web/lib/api.ts";
import { ConnectorCard } from "#web/pages/settings/connectors/card.tsx";
import { StaticConnectionDialog } from "#web/pages/settings/connectors/connection-dialogs.tsx";
import {
  ConnectorFilters,
  connectorCategoryOptions,
  filterConnectorRows,
} from "#web/pages/settings/connectors/filters.tsx";
import { RegistrationDialog } from "#web/pages/settings/connectors/registration-dialog.tsx";
import type {
  CatalogProvider,
  ConnectorConnection,
  ConnectorInstallation,
  ConnectorMeta,
  Registration,
  Scope,
} from "#web/pages/settings/connectors/shared.tsx";

export type ProviderRow = {
  provider: CatalogProvider;
  connections: ConnectorConnection[];
  installations: ConnectorInstallation[];
  needsSetup: boolean;
};

const adminStatusOptions = [
  { value: "all", label: "All statuses" },
  { value: "healthy", label: "Healthy" },
  { value: "attention", label: "Needs attention" },
  { value: "disconnected", label: "Not connected" },
  { value: "setup", label: "Needs setup" },
];

export function SettingsConnectorsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const connections = useQuery(orpc.connectors.connections.list.queryOptions({ input: {} }));
  const installations = useQuery(orpc.connectors.installations.list.queryOptions({ input: {} }));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const registrations = useQuery(orpc.connectors.registrations.list.queryOptions({}));
  const meta = useQuery(orpc.connectors.meta.queryOptions({}));
  const [registrationProvider, setRegistrationProvider] = useState<CatalogProvider>();
  const [staticProvider, setStaticProvider] = useState<CatalogProvider>();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [status, setStatus] = useState("all");
  const providers = (catalog.data ?? []) as CatalogProvider[];
  const connectionRows = (connections.data ?? []) as ConnectorConnection[];
  const installationRows = (installations.data ?? []) as ConnectorInstallation[];
  const scopeRows = ((scopes.data ?? []) as Scope[]).filter(
    (scope) => scope.kind === "org" || scope.kind === "shared",
  );
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
  const filteredRows = filterConnectorRows({
    rows: rows.filter((row) => status === "all" || providerStatus(row) === status),
    search,
    category,
    providerOf: (row) => row.provider,
  });
  const error =
    catalog.error ??
    connections.error ??
    installations.error ??
    scopes.error ??
    registrations.error ??
    meta.error;
  const pending =
    catalog.isPending ||
    connections.isPending ||
    installations.isPending ||
    scopes.isPending ||
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
        title="Organization connectors"
        description="Manage provider accounts, availability, audience, and tools."
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
        <div className="space-y-6">
          <ConnectorFilters
            search={search}
            onSearchChange={setSearch}
            category={category}
            onCategoryChange={setCategory}
            categoryOptions={connectorCategoryOptions(providers)}
            kindLabel="Status"
            kind={status}
            onKindChange={setStatus}
            kindOptions={adminStatusOptions}
          />
          {filteredRows.length === 0 ? (
            <div className="rounded-md border bg-card">
              <EmptyState
                icon={Cable}
                title="No connectors match"
                description="Try a different search or filter."
              />
            </div>
          ) : (
            <div className="space-y-8">
              <CatalogSection
                title="Available providers"
                description="Open a provider to connect an account or review its availability."
                rows={filteredRows.filter((row) => !row.needsSetup)}
                onOpen={open}
              />
              <CatalogSection
                title="Needs setup"
                description="Add the organization's OAuth app before connecting."
                rows={filteredRows.filter((row) => row.needsSetup)}
                onOpen={open}
              />
            </div>
          )}
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
          scopes={scopeRows}
          defaultScopeId={scopeRows.find((scope) => scope.kind === "org")?.id}
          open
          onOpenChange={(next) => {
            if (!next) setStaticProvider(undefined);
          }}
          onConnected={async () => {
            const key = staticProvider.key;
            await Promise.all([
              queryClient.invalidateQueries({
                queryKey: orpc.connectors.connections.list.key(),
              }),
              queryClient.invalidateQueries({
                queryKey: orpc.connectors.installations.list.key(),
              }),
              queryClient.invalidateQueries({ queryKey: orpc.connectors.catalog.list.key() }),
            ]);
            setStaticProvider(undefined);
            navigate(`/settings/connectors/${key}`);
          }}
        />
      ) : null}
    </main>
  );
}

function providerStatus(row: ProviderRow) {
  if (row.needsSetup) return "setup";
  const active = row.connections.filter((connection) => !connection.isRevoked);
  if (active.length === 0) return "disconnected";
  const activeById = new Map(active.map((connection) => [connection.id, connection]));
  const installationsAreUsable =
    row.installations.length > 0 &&
    row.installations.every((installation) => {
      const connection = activeById.get(installation.connectionId);
      return connection?.isValid === true && installation.health === "available";
    });
  return active.every((connection) => connection.isValid) && installationsAreUsable
    ? "healthy"
    : "attention";
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

export function ProviderCard({ row, onOpen }: { row: ProviderRow; onOpen: () => void }) {
  const { provider } = row;
  const active = row.connections.filter((connection) => !connection.isRevoked);
  const healthy = providerStatus(row) === "healthy";
  return (
    <ConnectorCard
      provider={provider}
      onOpen={onOpen}
      {...(row.needsSetup
        ? {
            action: {
              label: "Setup",
              onClick: onOpen,
              icon: <Settings2 />,
              variant: "outline" as const,
            },
          }
        : active.length === 0
          ? { action: { label: "Connect", onClick: onOpen } }
          : {
              status: {
                value: healthy ? ("connected" as const) : ("expired" as const),
                label: healthy ? "Healthy" : "Needs attention",
              },
            })}
    />
  );
}
