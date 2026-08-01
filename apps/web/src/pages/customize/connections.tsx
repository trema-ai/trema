import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#web/components/ui/alert-dialog.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Skeleton } from "#web/components/ui/skeleton.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import {
  type ConnectorBody,
  type Item,
  normalizeConnectorBody,
  type Scope,
} from "#web/pages/customize/types.ts";
import { useAuthenticatedSession } from "#web/pages/home.tsx";
import { ConnectorCard } from "#web/pages/settings/connectors/card.tsx";
import { OAuthConnectionDialog } from "#web/pages/settings/connectors/connection-dialogs.tsx";
import {
  ConnectorFilters,
  connectorCategoryOptions,
  filterConnectorRows,
} from "#web/pages/settings/connectors/filters.tsx";
import {
  type CatalogProvider,
  type ConnectorAvailability,
  type ConnectorConnection,
  messageFrom,
} from "#web/pages/settings/connectors/shared.tsx";

type ConnectSelection = {
  provider: CatalogProvider;
  reconnect?: ConnectorConnection;
};

const roleRank = { viewer: 0, member: 1, admin: 2, owner: 3 } as const;

const memberSourceOptions = [
  { value: "all", label: "All connectors" },
  { value: "personal", label: "Your accounts" },
  { value: "organization", label: "Organization-provided" },
  { value: "available", label: "Available to connect" },
];

export function ConnectionsTab({
  items,
  scope,
  orgScope,
  loading,
}: {
  items: Item[];
  scope: Scope;
  orgScope?: Scope | undefined;
  loading: boolean;
}) {
  const session = useAuthenticatedSession();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selection, setSelection] = useState<ConnectSelection>();
  const [search, setSearch] = useState("");
  const [category, setCategory] = useState("all");
  const [source, setSource] = useState("all");
  const handledCallback = useRef<string | undefined>(undefined);
  const ownPersonal =
    scope.kind === "personal" && scope.ownerId === session.membership.principal.id;
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const memberConnections = useQuery({
    ...orpc.connectors.member.connections.list.queryOptions({ input: {} }),
    enabled: ownPersonal,
  });
  const connectorAvailability = useQuery({
    ...orpc.connectors.member.availability.list.queryOptions({}),
    enabled: ownPersonal,
  });
  const entries = (catalog.data ?? []) as CatalogProvider[];
  const entryByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);
  const connectionRows = useMemo(
    () => (memberConnections.data ?? []) as ConnectorConnection[],
    [memberConnections.data],
  );
  const healthByInstallationId = useMemo(
    () =>
      new Map(
        ((connectorAvailability.data ?? []) as ConnectorAvailability[]).map((availability) => [
          availability.itemId,
          availability.status,
        ]),
      ),
    [connectorAvailability.data],
  );
  const installations = items.flatMap((item) => {
    if (item.scopeId !== scope.id || item.kind !== "connector" || item.status === "archived") {
      return [];
    }
    const body = normalizeConnectorBody(item.body);
    return body === undefined ? [] : [{ item, body }];
  });
  const organizationInstallations =
    scope.kind === "personal" && orgScope
      ? items.flatMap((item) => {
          if (
            item.scopeId !== orgScope.id ||
            item.kind !== "connector" ||
            item.status === "archived"
          ) {
            return [];
          }
          const body = normalizeConnectorBody(item.body);
          if (body === undefined) return [];
          const provider = entryByKey.get(body.catalogKey);
          if (provider === undefined || provider.supportsPersonalOAuth) return [];
          const allowed =
            body.access.kind === "scope" || roleRank[session.role] >= roleRank[body.access.role];
          return allowed ? [{ item, body, provider }] : [];
        })
      : [];
  const eligibleConnections = connectionRows.filter(
    (connection) => entryByKey.get(connection.providerKey)?.supportsPersonalOAuth === true,
  );
  const connectedKeys = new Set(eligibleConnections.map((connection) => connection.providerKey));
  const available = entries.filter(
    (entry) => entry.supportsPersonalOAuth && !connectedKeys.has(entry.key),
  );
  const filteredConnections =
    source === "all" || source === "personal"
      ? filterConnectorRows({
          rows: eligibleConnections,
          search,
          category,
          providerOf: (connection) => entryByKey.get(connection.providerKey) as CatalogProvider,
          extraFieldsOf: (connection) => (connection.label ? [connection.label] : []),
        })
      : [];
  const filteredOrganizationInstallations =
    source === "all" || source === "organization"
      ? filterConnectorRows({
          rows: organizationInstallations,
          search,
          category,
          providerOf: (installation) => installation.provider,
          extraFieldsOf: () => ["organization provided"],
        })
      : [];
  const filteredAvailable =
    source === "all" || source === "available"
      ? filterConnectorRows({
          rows: available,
          search,
          category,
          providerOf: (provider) => provider,
          extraFieldsOf: () => ["available connect"],
        })
      : [];
  const memberProviders = [
    ...eligibleConnections.flatMap((connection) => {
      const provider = entryByKey.get(connection.providerKey);
      return provider ? [provider] : [];
    }),
    ...organizationInstallations.map((installation) => installation.provider),
    ...available,
  ];
  const filtersActive = search.trim() !== "" || category !== "all" || source !== "all";
  const matchCount =
    filteredConnections.length +
    filteredOrganizationInstallations.length +
    filteredAvailable.length;
  const connectedId = searchParams.get("connected");

  const removeSearchParams = useCallback(
    (names: readonly string[]) => {
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          for (const name of names) next.delete(name);
          return next;
        },
        { replace: true },
      );
    },
    [setSearchParams],
  );

  const invalidateConnections = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.connectors.member.connections.list.key() }),
      queryClient.invalidateQueries({
        queryKey: orpc.connectors.member.availability.list.key(),
      }),
      queryClient.invalidateQueries({
        queryKey: orpc.items.list.queryOptions({ input: {} }).queryKey,
      }),
    ]);
  }, [queryClient]);
  useEffect(() => {
    const connectorError = searchParams.get("connector_error");
    if (!connectorError) return;
    toast.error(`Connection failed: ${connectorError.replaceAll("_", " ")}`);
    removeSearchParams(["connector_error"]);
  }, [removeSearchParams, searchParams]);

  useEffect(() => {
    if (!connectedId) {
      handledCallback.current = undefined;
      return;
    }
    if (!ownPersonal || handledCallback.current === connectedId) return;
    handledCallback.current = connectedId;
    const setupStatus = searchParams.get("connector_status");
    removeSearchParams(["connected", "connector_status"]);
    void invalidateConnections();
    toast.success(
      setupStatus === "syncing"
        ? "Account connected; connector tools are still syncing"
        : setupStatus === "sync_failed"
          ? "Account connected; connector tool sync needs attention"
          : "Account connected",
    );
  }, [connectedId, invalidateConnections, ownPersonal, removeSearchParams, searchParams]);

  if (
    loading ||
    catalog.isPending ||
    (ownPersonal && (memberConnections.isPending || connectorAvailability.isPending))
  ) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  const error =
    catalog.error ??
    (ownPersonal ? (memberConnections.error ?? connectorAvailability.error) : null);
  if (error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!ownPersonal) {
    return <ReadOnlyConnections entries={entryByKey} installations={installations} scope={scope} />;
  }

  return (
    <div className="space-y-8">
      <ConnectorFilters
        search={search}
        onSearchChange={setSearch}
        category={category}
        onCategoryChange={setCategory}
        categoryOptions={connectorCategoryOptions(memberProviders)}
        kindLabel="Source"
        kind={source}
        onKindChange={setSource}
        kindOptions={memberSourceOptions}
      />

      {filtersActive && matchCount === 0 ? (
        <div className="rounded-md border bg-card">
          <EmptyState
            icon={Cable}
            title="No connectors match"
            description="Try a different search or filter."
          />
        </div>
      ) : (
        <>
          {(source === "all" || source === "personal") &&
          (filteredConnections.length > 0 || !filtersActive) ? (
            <ConnectionSection
              title="Your connections"
              description="Accounts Trema can use when acting as you."
            >
              {filteredConnections.length === 0 ? (
                <div className="rounded-md border bg-card">
                  <EmptyState
                    icon={Cable}
                    title="No accounts connected yet"
                    description="Connect an account from one of the available providers below."
                  />
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredConnections.map((connection) => {
                    const provider = entryByKey.get(connection.providerKey);
                    const personalInstallation = connection.installations.find(
                      (installation) => installation.scopeId === scope.id,
                    );
                    return provider ? (
                      <PersonalConnectionRow
                        key={connection.id}
                        provider={provider}
                        connection={connection}
                        personalScopeId={scope.id}
                        installationHealth={
                          personalInstallation
                            ? healthByInstallationId.get(personalInstallation.id)
                            : undefined
                        }
                        onReconnect={() => setSelection({ provider, reconnect: connection })}
                        onChanged={invalidateConnections}
                      />
                    ) : null;
                  })}
                </div>
              )}
            </ConnectionSection>
          ) : null}

          {filteredOrganizationInstallations.length > 0 ? (
            <ConnectionSection
              title="Provided by your organization"
              description="These organization-managed connectors are also available in your personal scope."
            >
              <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                {filteredOrganizationInstallations.map(({ item, body, provider }) => (
                  <OrganizationConnectionCard
                    key={item.id}
                    provider={provider}
                    body={body}
                    health={healthByInstallationId.get(item.id) ?? "missing"}
                  />
                ))}
              </div>
            </ConnectionSection>
          ) : null}

          {(source === "all" || source === "available") &&
          (filteredAvailable.length > 0 || !filtersActive) ? (
            <ConnectionSection
              title="Available"
              description="Connect an account from any of these providers."
            >
              {filteredAvailable.length === 0 ? (
                <div className="rounded-md border bg-card">
                  <EmptyState
                    icon={Cable}
                    title="No connections available"
                    description="Every available provider already has an account connected."
                  />
                </div>
              ) : (
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                  {filteredAvailable.map((provider) => (
                    <AvailableConnectionCard
                      key={provider.key}
                      provider={provider}
                      onConnect={() => setSelection({ provider })}
                    />
                  ))}
                </div>
              )}
            </ConnectionSection>
          ) : null}
        </>
      )}

      {selection ? (
        <OAuthConnectionDialog
          audience="member"
          provider={selection.provider}
          reconnect={selection.reconnect}
          open
          onOpenChange={(open) => {
            if (!open) setSelection(undefined);
          }}
        />
      ) : null}
    </div>
  );
}

function ReadOnlyConnections({
  entries,
  installations,
  scope,
}: {
  entries: Map<string, CatalogProvider>;
  installations: Array<{ item: Item; body: ConnectorBody }>;
  scope: Scope;
}) {
  return (
    <ConnectionSection
      title="Connections in this scope"
      description={
        scope.kind === "personal"
          ? "Personal connections are managed by their owner."
          : "Trema can use these connectors in this location. Admins manage them in settings."
      }
    >
      {installations.length === 0 ? (
        <div className="rounded-md border bg-card">
          <EmptyState
            icon={Cable}
            title="No connections in this scope"
            description={
              scope.kind === "personal"
                ? "No provider account is connected to this personal scope."
                : "An admin can make a connector available from organization settings."
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {installations.map(({ item, body }) => {
            const provider = entries.get(body.catalogKey);
            if (!provider) return null;
            return (
              <ConnectorCard
                key={item.id}
                provider={provider}
                {...(scope.kind === "personal"
                  ? {}
                  : { identity: { kind: "organization" as const } })}
                detail={
                  <>
                    {body.access.kind === "scope"
                      ? "Everyone in this location"
                      : `${body.access.role} or higher`}{" "}
                    ·{" "}
                    {body.enabledTools === "all"
                      ? "All tools"
                      : `${body.enabledTools.length} enabled tools`}
                  </>
                }
              />
            );
          })}
        </div>
      )}
    </ConnectionSection>
  );
}

function ConnectionSection({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="space-y-3">
      <div>
        <h3 className="font-medium text-chrome text-muted-foreground">{title}</h3>
        <p className="mt-1 text-meta text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function AvailableConnectionCard({
  provider,
  onConnect,
}: {
  provider: CatalogProvider;
  onConnect: () => void;
}) {
  return (
    <ConnectorCard
      provider={provider}
      action={{ label: "Connect", onClick: onConnect }}
      onOpen={onConnect}
    />
  );
}

export function PersonalConnectionRow({
  provider,
  connection,
  personalScopeId,
  installationHealth,
  onReconnect,
  onChanged,
}: {
  provider: CatalogProvider;
  connection: ConnectorConnection;
  personalScopeId: string;
  installationHealth: ConnectorAvailability["status"] | undefined;
  onReconnect: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const revoke = useMutation({
    mutationFn: () =>
      rpcClient.connectors.member.connections.revoke({ connectionId: connection.id }),
    onSuccess: async () => {
      await onChanged();
      setConfirm(false);
      toast.success(`${provider.displayName} disconnected`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const isInstalled = connection.installations.some(
    (installation) => installation.scopeId === personalScopeId,
  );
  const installationReady = installationHealth === "available";
  const needsSetup = !isInstalled || !installationReady;
  const statusLabel =
    connection.isValid && needsSetup
      ? "Setup needed"
      : connection.isRevoked
        ? "Revoked"
        : connection.refreshExhausted
          ? "Reconnect needed"
          : connection.isCredentialUnavailable
            ? "Reconnect needed"
            : connection.isExpired
              ? "Expired"
              : "Connected";
  const accountLabel = connection.label ?? provider.displayName;

  return (
    <>
      <ConnectorCard
        provider={provider}
        identity={{ kind: "personal", accountLabel }}
        status={{
          value: connection.isValid ? (needsSetup ? "missing" : "connected") : "expired",
          label: statusLabel,
        }}
        detail={
          <>
            Connected <RelativeTime date={connection.createdAt} />
            {connection.expiresAt ? (
              <>
                {" "}
                · Expires <RelativeTime date={connection.expiresAt} />
              </>
            ) : null}
          </>
        }
        footer={
          <>
            {!connection.isValid || needsSetup ? (
              <Button size="xs" variant="outline" onClick={onReconnect}>
                <RefreshCw />
                Reconnect
              </Button>
            ) : null}
            {!connection.isRevoked ? (
              <Button size="xs" variant="destructive" onClick={() => setConfirm(true)}>
                Disconnect
              </Button>
            ) : null}
          </>
        }
      />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {accountLabel}?</AlertDialogTitle>
            <AlertDialogDescription>
              Trema will stop using this {provider.displayName} account when acting as you. You can
              reconnect it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {revoke.isPending ? "Disconnecting…" : "Disconnect"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

export function OrganizationConnectionCard({
  provider,
  body,
  health,
}: {
  provider: CatalogProvider;
  body: ConnectorBody;
  health: ConnectorAvailability["status"];
}) {
  const status = organizationHealthBadge(health);
  return (
    <ConnectorCard
      provider={provider}
      identity={{ kind: "organization" }}
      status={status}
      detail={
        body.enabledTools === "all"
          ? "All available tools"
          : `${body.enabledTools.length} tool${body.enabledTools.length === 1 ? "" : "s"}`
      }
    />
  );
}

function organizationHealthBadge(health: ConnectorAvailability["status"]): {
  value: "connected" | "missing" | "expired";
  label: string;
} {
  switch (health) {
    case "available":
      return { value: "connected", label: "Available" };
    case "revoked":
      return { value: "expired", label: "Disconnected" };
    case "expired":
      return { value: "expired", label: "Expired" };
    case "refresh_exhausted":
      return { value: "expired", label: "Reconnect needed" };
    case "unavailable":
      return { value: "missing", label: "Unavailable" };
    case "setup_required":
      return { value: "missing", label: "Setup needed" };
    case "missing":
      return { value: "missing", label: "Unavailable" };
  }
}
