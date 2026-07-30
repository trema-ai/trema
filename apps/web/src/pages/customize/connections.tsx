import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, RefreshCw } from "lucide-react";
import { type ReactNode, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";
import { CredentialStatusBadge } from "#web/components/trema/credential-status-badge.tsx";
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
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#web/components/ui/card.tsx";
import { Skeleton } from "#web/components/ui/skeleton.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import type { ConnectorBody, Item, Scope } from "#web/pages/customize/types.ts";
import { useAuthenticatedSession } from "#web/pages/home.tsx";
import { OAuthConnectionDialog } from "#web/pages/settings/connectors/connection-dialogs.tsx";
import {
  authModeLabel,
  type CatalogProvider,
  type ConnectorConnection,
  categoryLabel,
  messageFrom,
  providerLogo,
} from "#web/pages/settings/connectors/shared.tsx";

type ConnectSelection = {
  provider: CatalogProvider;
  reconnect?: ConnectorConnection;
};

export function ConnectionsTab({
  items,
  scope,
  loading,
}: {
  items: Item[];
  scope: Scope;
  loading: boolean;
}) {
  const session = useAuthenticatedSession();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const [selection, setSelection] = useState<ConnectSelection>();
  const handledCallback = useRef<string | undefined>(undefined);
  const ownPersonal =
    scope.kind === "personal" && scope.ownerId === session.membership.principal.id;
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const memberConnections = useQuery({
    ...orpc.connectors.member.connections.list.queryOptions({ input: {} }),
    enabled: ownPersonal,
  });
  const entries = (catalog.data ?? []) as CatalogProvider[];
  const entryByKey = useMemo(() => new Map(entries.map((entry) => [entry.key, entry])), [entries]);
  const connectionRows = useMemo(
    () => (memberConnections.data ?? []) as ConnectorConnection[],
    [memberConnections.data],
  );
  const installations = items.filter(
    (item) => item.kind === "connector" && item.status !== "archived",
  );
  const eligibleConnections = connectionRows.filter(
    (connection) => entryByKey.get(connection.providerKey)?.supportsPersonalOAuth === true,
  );
  const connectedKeys = new Set(eligibleConnections.map((connection) => connection.providerKey));
  const available = entries.filter(
    (entry) => entry.supportsPersonalOAuth && !connectedKeys.has(entry.key),
  );
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
        ? "Connection added; connector tools are still syncing"
        : setupStatus === "sync_failed"
          ? "Connection added; connector tool sync needs attention"
          : "Connection added to your personal scope",
    );
  }, [connectedId, invalidateConnections, ownPersonal, removeSearchParams, searchParams]);

  if (loading || catalog.isPending || (ownPersonal && memberConnections.isPending)) {
    return (
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {[1, 2, 3].map((key) => (
          <Skeleton key={key} className="h-40 w-full" />
        ))}
      </div>
    );
  }
  const error = catalog.error ?? (ownPersonal ? memberConnections.error : null);
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
      <ConnectionSection
        title="Your connections"
        description="Provider accounts connected for your personal scope."
      >
        {eligibleConnections.length === 0 ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Cable}
              title="No personal connections yet"
              description="Connect a provider account for use in your personal scope."
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {eligibleConnections.map((connection) => {
              const provider = entryByKey.get(connection.providerKey);
              return provider ? (
                <PersonalConnectionRow
                  key={connection.id}
                  provider={provider}
                  connection={connection}
                  onReconnect={() => setSelection({ provider, reconnect: connection })}
                  onChanged={invalidateConnections}
                />
              ) : null;
            })}
          </div>
        )}
      </ConnectionSection>

      <ConnectionSection
        title="Available"
        description="Providers that support personal OAuth connections."
      >
        {available.length === 0 ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Cable}
              title="No connections available"
              description="You have connected every provider that supports personal OAuth."
            />
          </div>
        ) : (
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
            {available.map((provider) => (
              <AvailableConnectionCard
                key={provider.key}
                provider={provider}
                onConnect={() => setSelection({ provider })}
              />
            ))}
          </div>
        )}
      </ConnectionSection>

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
  installations: Item[];
  scope: Scope;
}) {
  return (
    <ConnectionSection
      title="Connections in this scope"
      description={
        scope.kind === "personal"
          ? "Personal connections are managed by their owner."
          : "The agent uses these provider bindings in shared sessions. Admins manage them in settings."
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
                : "An admin can add a connector from the admin settings area."
            }
          />
        </div>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {installations.map((item) => {
            const body = item.body as ConnectorBody;
            const provider = entries.get(body.catalogKey);
            return (
              <Card key={item.id} className="gap-2 py-4 shadow-xs">
                <CardHeader className="px-4">
                  <div className="flex items-center gap-2">
                    {provider ? providerLogo(provider) : null}
                    <div className="min-w-0">
                      <CardTitle>{provider?.displayName ?? item.title}</CardTitle>
                      {provider ? (
                        <p className="mt-0.5 text-meta text-muted-foreground">
                          {categoryLabel(provider.categories)}
                        </p>
                      ) : null}
                    </div>
                  </div>
                </CardHeader>
                <CardContent className="px-4">
                  {provider ? (
                    <CardDescription>
                      {provider.description ?? "No description available."}
                    </CardDescription>
                  ) : null}
                  <p className="mt-2 text-meta text-muted-foreground">
                    {body.enabledTools === "all"
                      ? "All tools"
                      : `${body.enabledTools.length} enabled tools`}
                  </p>
                </CardContent>
              </Card>
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
    <Card
      className="cursor-pointer gap-2 py-4 shadow-xs transition-colors hover:bg-muted/40"
      onClick={onConnect}
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
        <CardAction>
          <Button
            size="xs"
            onClick={(event) => {
              event.stopPropagation();
              onConnect();
            }}
          >
            Connect
          </Button>
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        <CardDescription>{provider.description ?? "No description available."}</CardDescription>
      </CardContent>
    </Card>
  );
}

function PersonalConnectionRow({
  provider,
  connection,
  onReconnect,
  onChanged,
}: {
  provider: CatalogProvider;
  connection: ConnectorConnection;
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
      toast.success("Connection revoked");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const statusLabel = connection.isRevoked
    ? "Revoked"
    : connection.isExpired
      ? "Expired"
      : connection.refreshExhausted
        ? "Reconnect needed"
        : "Connected";

  return (
    <>
      <Card className="gap-2 py-4 shadow-xs">
        <CardHeader className="px-4">
          <div className="flex items-center gap-2">
            {providerLogo(provider)}
            <div className="min-w-0">
              <CardTitle>{connection.label ?? provider.displayName}</CardTitle>
              <p className="mt-0.5 text-meta text-muted-foreground">
                {categoryLabel(provider.categories)}
              </p>
            </div>
          </div>
          <CardAction>
            <CredentialStatusBadge
              status={connection.isValid ? "connected" : "expired"}
              label={statusLabel}
            />
          </CardAction>
        </CardHeader>
        <CardContent className="px-4">
          <CardDescription>{provider.description ?? "No description available."}</CardDescription>
          <p className="mt-2 text-meta text-muted-foreground">
            {authModeLabel(connection.authMode)} · Connected{" "}
            <RelativeTime date={connection.createdAt} />
            {connection.expiresAt ? (
              <>
                {" "}
                · Expires <RelativeTime date={connection.expiresAt} />
              </>
            ) : null}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            {!connection.isValid ? (
              <Button size="xs" variant="outline" onClick={onReconnect}>
                <RefreshCw />
                Reconnect
              </Button>
            ) : null}
            {!connection.isRevoked ? (
              <Button size="xs" variant="destructive" onClick={() => setConfirm(true)}>
                Revoke
              </Button>
            ) : null}
          </div>
        </CardContent>
      </Card>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              The agent will stop using it in your personal sessions. You can reconnect it later.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={revoke.isPending}
              onClick={() => revoke.mutate()}
            >
              {revoke.isPending ? "Revoking…" : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
