import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Cable, ExternalLink, RefreshCw } from "lucide-react";
import { type ReactNode, useMemo, useState } from "react";
import { toast } from "sonner";

import {
  type CredentialStatus,
  CredentialStatusBadge,
} from "#/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { SensitivityBadge } from "#/components/trema/sensitivity-badge.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import {
  type CatalogEntry,
  type ConnectorBody,
  type ConnectorCredential,
  type ConnectorTool,
  type Item,
  messageFrom,
  type Scope,
  type Sensitivity,
} from "#/pages/customize/types.ts";
import { useAuthenticatedSession } from "#/pages/home.tsx";

const oauthModes = new Set(["oauth2_code", "mcp_oauth"]);
const sensitivityOrder: Sensitivity[] = ["read", "write", "destructive"];

function credentialStatus(rows: ConnectorCredential[]): CredentialStatus {
  if (rows.some((row) => row.isValid)) return "connected";
  if (rows.some((row) => row.isExpired)) return "expired";
  return "missing";
}

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
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions());
  const [selectedId, setSelectedId] = useState<string>();
  const entries = (catalog.data ?? []) as CatalogEntry[];
  const entryByKey = new Map(entries.map((entry) => [entry.key, entry]));
  const ownPersonal =
    scope.kind === "personal" && scope.ownerId === session.membership.principal.id;
  const connections = items.filter(
    (item) => item.kind === "connector" && item.status !== "archived",
  );
  const installedKeys = new Set(connections.map((item) => (item.body as ConnectorBody).catalogKey));
  const available = entries.filter(
    (entry) => entry.memberConnectable && !installedKeys.has(entry.key),
  );
  const selected = ownPersonal ? connections.find((item) => item.id === selectedId) : undefined;

  if (loading || catalog.isPending) {
    return (
      <div className="space-y-3">
        <Skeleton className="h-24 w-full" />
        <Skeleton className="h-24 w-full" />
      </div>
    );
  }
  if (catalog.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{catalog.error.message}</AlertDescription>
      </Alert>
    );
  }
  if (!ownPersonal) {
    return (
      <ConnectionSection
        title="Connections in this scope"
        description="The agent uses these in shared sessions. Managed by your admins."
      >
        {connections.length === 0 ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Cable}
              title="No connections in this scope yet"
              description="Admins install shared connections in the admin area."
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <div className="divide-y">
              {connections.map((item) => {
                const entry = entryByKey.get((item.body as ConnectorBody).catalogKey);
                return (
                  <div key={item.id} className="flex items-center gap-3 px-4 py-3">
                    <span className="min-w-0 flex-1 truncate text-chrome font-medium">
                      {entry?.displayName ?? item.title}
                    </span>
                  </div>
                );
              })}
            </div>
          </div>
        )}
      </ConnectionSection>
    );
  }
  return (
    <div className="space-y-8">
      <ConnectionSection
        title="Your connections"
        description="The agent acts as you with these when you message it privately."
      >
        {connections.length === 0 ? (
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Cable}
              title="No personal connections yet"
              description="Connect a tool below to let the agent act on your behalf."
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border bg-card">
            <div className="divide-y">
              {connections.map((item) => (
                <PersonalConnectionRow
                  key={item.id}
                  item={item}
                  entry={entryByKey.get((item.body as ConnectorBody).catalogKey)}
                  onSelect={() => setSelectedId(item.id)}
                />
              ))}
            </div>
          </div>
        )}
      </ConnectionSection>

      {available.length > 0 ? (
        <ConnectionSection
          title="Available to connect"
          description="Tools your admins have enabled for personal connections."
        >
          <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
            {available.map((entry) => (
              <CatalogCard
                key={entry.key}
                entry={entry}
                personalScopeId={scope.id}
                principalId={session.membership.principal.id}
              />
            ))}
          </div>
        </ConnectionSection>
      ) : null}

      <ConnectionDetailSheet
        item={selected}
        entry={selected ? entryByKey.get((selected.body as ConnectorBody).catalogKey) : undefined}
        principalId={session.membership.principal.id}
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedId(undefined);
        }}
      />
    </div>
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
        <h3 className="text-chrome font-medium text-muted-foreground">{title}</h3>
        <p className="mt-1 text-meta text-muted-foreground">{description}</p>
      </div>
      {children}
    </section>
  );
}

function PersonalConnectionRow({
  item,
  entry,
  onSelect,
}: {
  item: Item;
  entry: CatalogEntry | undefined;
  onSelect: () => void;
}) {
  const body = item.body as ConnectorBody;
  const credentials = useQuery(
    orpc.connectors.credentials.list.queryOptions({
      input: { installationItemId: item.id },
    }),
  );
  const rows = (credentials.data ?? []) as ConnectorCredential[];
  const tools = entry?.transport.type === "rest" ? entry.toolManifest : body.syncedTools;
  const toolCount = body.enabledTools === "all" ? tools?.length : body.enabledTools.length;

  return (
    <button
      type="button"
      onClick={onSelect}
      className="flex w-full items-center gap-3 px-4 py-3 text-left hover:bg-muted/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
    >
      <div className="min-w-0 flex-1">
        <p className="truncate text-chrome font-medium">{entry?.displayName ?? item.title}</p>
        <p className="text-meta text-muted-foreground">
          {toolCount === undefined
            ? "Tools not synced"
            : `${toolCount} ${toolCount === 1 ? "tool" : "tools"}`}
        </p>
      </div>
      {credentials.isPending ? (
        <Skeleton className="h-5 w-20" />
      ) : (
        <CredentialStatusBadge status={credentialStatus(rows)} />
      )}
    </button>
  );
}

function ConnectionDetailSheet({
  item,
  entry,
  principalId,
  open,
  onOpenChange,
}: {
  item: Item | undefined;
  entry: CatalogEntry | undefined;
  principalId: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {item ? (
        <ConnectionDetailContent
          key={`${item.id}:${item.version}`}
          item={item}
          entry={entry}
          principalId={principalId}
          onRemoved={() => onOpenChange(false)}
        />
      ) : null}
    </Sheet>
  );
}

function ConnectionDetailContent({
  item,
  entry,
  principalId,
  onRemoved,
}: {
  item: Item;
  entry: CatalogEntry | undefined;
  principalId: string;
  onRemoved: () => void;
}) {
  const queryClient = useQueryClient();
  const body = item.body as ConnectorBody;
  const credentials = useQuery(
    orpc.connectors.credentials.list.queryOptions({
      input: { installationItemId: item.id },
    }),
  );
  const credentialRows = (credentials.data ?? []) as ConnectorCredential[];
  const activeCredential = credentialRows.find((row) => !row.isRevoked);
  const tools = useMemo(() => {
    const available =
      entry?.transport.type === "rest" ? (entry.toolManifest ?? []) : (body.syncedTools ?? []);
    return available.map((tool) => ({
      ...tool,
      sensitivity: body.sensitivityOverrides?.[tool.name] ?? tool.sensitivity,
    }));
  }, [body.sensitivityOverrides, body.syncedTools, entry]);
  const initiallyEnabled =
    body.enabledTools === "all"
      ? new Set(tools.map((tool) => tool.name))
      : new Set(body.enabledTools);
  const [enabled, setEnabled] = useState(initiallyEnabled);

  async function invalidateItems() {
    await queryClient.invalidateQueries({
      queryKey: orpc.items.list.queryOptions({ input: {} }).queryKey,
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const names = tools.filter((tool) => enabled.has(tool.name)).map((tool) => tool.name);
      return rpcClient.connectors.installations.update({
        installationItemId: item.id,
        enabledTools: names.length === tools.length ? "all" : names,
      });
    },
    onSuccess: async () => {
      await invalidateItems();
      toast.success("Tool permissions saved");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const reconnect = useMutation({
    mutationFn: async () => {
      const result = await rpcClient.connectors.connect.startOAuth({
        installationItemId: item.id,
        providerKey: body.catalogKey,
        principalId,
        returnTo: window.location.href,
      });
      window.location.assign(result.authorizationUrl);
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const sync = useMutation({
    mutationFn: () => rpcClient.connectors.installations.sync({ installationItemId: item.id }),
    onSuccess: async ({ report }) => {
      await invalidateItems();
      toast.success(
        `Tools synced: ${report.added.length} added, ${report.removed.length} removed, ${report.changed.length} changed`,
      );
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const revoke = useMutation({
    mutationFn: () =>
      activeCredential
        ? rpcClient.connectors.credentials.revoke({
            installationItemId: item.id,
            credentialId: activeCredential.id,
          })
        : Promise.reject(new Error("No credential to revoke")),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: orpc.connectors.credentials.list.queryOptions({
          input: { installationItemId: item.id },
        }).queryKey,
      });
      toast.success("Credential revoked");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const remove = useMutation({
    mutationFn: () => rpcClient.items.archive({ id: item.id }),
    onSuccess: async () => {
      await invalidateItems();
      toast.success("Connection archived");
      onRemoved();
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  const grouped = sensitivityOrder.map((sensitivity) => ({
    sensitivity,
    tools: tools.filter((tool) => tool.sensitivity === sensitivity),
  }));

  return (
    <SheetContent className="overflow-y-auto sm:max-w-xl">
      <SheetHeader className="border-b">
        <SheetTitle>{entry?.displayName ?? item.title}</SheetTitle>
        <SheetDescription>Manage credentials and the tools the agent may use.</SheetDescription>
      </SheetHeader>
      <div className="space-y-5 px-4">
        <div className="flex flex-wrap items-center gap-3">
          {credentials.isPending ? (
            <Skeleton className="h-5 w-20" />
          ) : (
            <CredentialStatusBadge status={credentialStatus(credentialRows)} />
          )}
          {entry?.docsUrl ? (
            <a
              href={entry.docsUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 text-chrome text-moss hover:underline"
            >
              Documentation <ExternalLink className="size-3.5" />
            </a>
          ) : null}
        </div>

        <section className="space-y-3">
          <div>
            <h3 className="text-chrome font-medium">Tool permissions</h3>
            <p className="mt-1 text-meta text-muted-foreground">
              Choose which tools the agent can use through this connection.
            </p>
          </div>
          {tools.length === 0 ? (
            <div className="rounded-md border bg-card p-3 text-chrome text-muted-foreground">
              No tools are known yet. Sync this connection to discover its tools.
            </div>
          ) : (
            <div className="space-y-4">
              {grouped.map((group) =>
                group.tools.length > 0 ? (
                  <div key={group.sensitivity} className="space-y-2">
                    <SensitivityBadge sensitivity={group.sensitivity} />
                    <div className="divide-y rounded-md border bg-card">
                      {group.tools.map((tool) => (
                        <ToolRow
                          key={tool.name}
                          tool={tool}
                          checked={enabled.has(tool.name)}
                          onCheckedChange={(checked) => {
                            setEnabled((current) => {
                              const next = new Set(current);
                              if (checked) next.add(tool.name);
                              else next.delete(tool.name);
                              return next;
                            });
                          }}
                        />
                      ))}
                    </div>
                  </div>
                ) : null,
              )}
              <Button disabled={save.isPending} onClick={() => save.mutate()}>
                {save.isPending ? "Saving…" : "Save tool permissions"}
              </Button>
            </div>
          )}
        </section>

        <section className="space-y-3 border-t pt-4">
          <h3 className="text-chrome font-medium">Connection actions</h3>
          <div className="flex flex-wrap gap-2">
            {entry && oauthModes.has(entry.authMode) ? (
              <Button
                variant="outline"
                disabled={reconnect.isPending}
                onClick={() => reconnect.mutate()}
              >
                <RefreshCw />
                {reconnect.isPending ? "Redirecting…" : "Reconnect"}
              </Button>
            ) : null}
            {entry?.transport.type === "mcp" ? (
              <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
                <RefreshCw />
                {sync.isPending ? "Syncing…" : "Sync tools"}
              </Button>
            ) : null}
            {activeCredential ? (
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="outline">Revoke credential</Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Revoke this credential?</AlertDialogTitle>
                    <AlertDialogDescription>
                      The agent loses access as you until you reconnect this connection.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction
                      variant="destructive"
                      disabled={revoke.isPending}
                      onClick={() => revoke.mutate()}
                    >
                      {revoke.isPending ? "Revoking…" : "Revoke credential"}
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            ) : null}
          </div>
        </section>
      </div>
      <SheetFooter className="border-t">
        <AlertDialog>
          <AlertDialogTrigger asChild>
            <Button variant="outline">Remove connection</Button>
          </AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this connection?</AlertDialogTitle>
              <AlertDialogDescription>
                The connection is archived and can be restored later. Its credentials stop being
                used.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => remove.mutate()}
              >
                {remove.isPending ? "Removing…" : "Remove connection"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </SheetFooter>
    </SheetContent>
  );
}

function ToolRow({
  tool,
  checked,
  onCheckedChange,
}: {
  tool: ConnectorTool;
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
}) {
  const id = `tool-${tool.name.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
  return (
    <div className="flex items-start gap-3 px-3 py-2.5">
      <Checkbox
        id={id}
        checked={checked}
        onCheckedChange={(value) => onCheckedChange(value === true)}
        className="mt-0.5"
      />
      <Label htmlFor={id} className="min-w-0 flex-1 cursor-pointer">
        <span className="block font-mono text-meta">{tool.name}</span>
        {tool.description ? (
          <span className="mt-0.5 block text-meta font-normal text-muted-foreground">
            {tool.description}
          </span>
        ) : null}
      </Label>
    </div>
  );
}

function CatalogCard({
  entry,
  personalScopeId,
  principalId,
}: {
  entry: CatalogEntry;
  personalScopeId: string;
  principalId: string;
}) {
  const queryClient = useQueryClient();
  const connect = useMutation({
    mutationFn: async () => {
      const installation = await rpcClient.connectors.installations.create({
        scopeId: personalScopeId,
        catalogKey: entry.key,
        enabledTools: "all",
      });
      const result = await rpcClient.connectors.connect.startOAuth({
        installationItemId: installation.id,
        providerKey: entry.key,
        principalId,
        returnTo: window.location.href,
      });
      window.location.assign(result.authorizationUrl);
    },
    onError: async (cause) => {
      await queryClient.invalidateQueries({
        queryKey: orpc.items.list.queryOptions({ input: {} }).queryKey,
      });
      toast.error(messageFrom(cause));
    },
  });
  const oauth = oauthModes.has(entry.authMode);

  return (
    <div className="flex flex-col gap-3 rounded-md border bg-card p-4">
      <div className="min-w-0">
        <p className="truncate text-chrome font-medium">{entry.displayName}</p>
        <p className="truncate text-meta text-muted-foreground">
          {entry.categories.join(" · ") || "Connector"}
        </p>
      </div>
      <Button
        variant="outline"
        size="sm"
        className="self-start"
        disabled={!oauth || connect.isPending}
        onClick={() => connect.mutate()}
      >
        {connect.isPending ? "Redirecting…" : oauth ? "Connect" : "Coming soon"}
      </Button>
    </div>
  );
}
