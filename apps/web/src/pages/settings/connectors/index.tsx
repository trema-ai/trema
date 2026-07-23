import { useQuery } from "@tanstack/react-query";
import { Cable, Plus } from "lucide-react";
import { useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router";

import { CredentialStatusBadge } from "#/components/trema/credential-status-badge.tsx";
import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { ScopeBadge } from "#/components/trema/scope-badge.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { orpc } from "#/lib/api.ts";
import { scopeDisplayName } from "#/lib/scopes.ts";
import {
  type CatalogProvider,
  type ConnectorInstallation,
  providerLogo,
  type Scope,
} from "#/pages/settings/connectors/shared.tsx";

export function SettingsConnectorsPage() {
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const scopeId = searchParams.get("scope") ?? undefined;
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const installations = useQuery(
    orpc.connectors.installations.list.queryOptions({
      input: scopeId ? { scopeId } : {},
    }),
  );
  const scopeRows = ((scopes.data ?? []) as Scope[]).filter(
    (scope) => scope.kind === "org" || scope.kind === "shared",
  );
  const providers = catalog.data as CatalogProvider[] | undefined;
  const rows = (installations.data ?? []) as ConnectorInstallation[];
  const scopesById = useMemo(
    () => new Map(scopeRows.map((scope) => [scope.id, scope])),
    [scopeRows],
  );
  const providersByKey = useMemo(
    () => new Map((providers ?? []).map((provider) => [provider.key, provider])),
    [providers],
  );

  const columns: DataTableColumn<ConnectorInstallation>[] = [
    {
      key: "connector",
      header: "Connector",
      render: (installation) => {
        const provider = providersByKey.get(installation.catalogKey);
        return (
          <div className="flex items-center gap-2.5">
            {provider ? providerLogo(provider, "size-8") : null}
            <span className="font-medium">{provider?.displayName ?? installation.catalogKey}</span>
          </div>
        );
      },
    },
    {
      key: "scope",
      header: "Scope",
      render: (installation) => {
        const scope = scopesById.get(installation.scopeId);
        return <ScopeBadge scope={scope ? scopeDisplayName(scope) : installation.scopeId} />;
      },
    },
    {
      key: "credential",
      header: "Credential status",
      render: (installation) => {
        if (installation.credentials.some((credential) => credential.isValid)) {
          return <CredentialStatusBadge status="connected" label="Connected" />;
        }
        if (installation.credentials.length === 0) {
          return <CredentialStatusBadge status="missing" label="Not connected" />;
        }
        return <CredentialStatusBadge status="expired" label="Reconnect needed" />;
      },
    },
    {
      key: "tools",
      header: "Enabled tools",
      render: (installation) => {
        if (installation.enabledTools === "all") return "All tools";
        const provider = providersByKey.get(installation.catalogKey);
        const total =
          provider?.transport.type === "rest"
            ? (provider.toolManifest?.length ?? 0)
            : installation.syncedTools.length;
        return `${installation.enabledTools.length} of ${total}`;
      },
    },
    {
      key: "updated",
      header: "Last updated",
      render: (installation) => <RelativeTime date={installation.updatedAt} />,
    },
  ];
  const error = scopes.error ?? catalog.error ?? installations.error;

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Connectors"
        description="Manage connectors installed in organization and shared scopes."
        actions={
          <Button onClick={() => navigate("/settings/connectors/catalog")}>
            <Plus />
            Install connector
          </Button>
        }
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      <div className="mb-4 w-full max-w-xs space-y-2">
        <Label htmlFor="connector-scope">Scope</Label>
        <Select
          value={scopeId ?? "all"}
          onValueChange={(value) => {
            setSearchParams((current) => {
              const next = new URLSearchParams(current);
              if (value === "all") next.delete("scope");
              else next.set("scope", value);
              return next;
            });
          }}
        >
          <SelectTrigger id="connector-scope" className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All scopes</SelectItem>
            {scopeRows.map((scope) => (
              <SelectItem key={scope.id} value={scope.id}>
                {scopeDisplayName(scope)}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(installation) => installation.id}
        onRowClick={(installation) => navigate(`/settings/connectors/${installation.id}`)}
        loading={scopes.isPending || catalog.isPending || installations.isPending}
        empty={
          <EmptyState
            icon={Cable}
            title="No installed connectors"
            description={
              scopeId
                ? "No connectors are installed in this scope."
                : "Install a connector to give agents access to an external service."
            }
            action={
              <Button onClick={() => navigate("/settings/connectors/catalog")}>
                <Plus />
                Install connector
              </Button>
            }
          />
        }
      />
    </main>
  );
}
