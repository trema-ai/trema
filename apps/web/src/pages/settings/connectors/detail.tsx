import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  ChevronDown,
  MoreHorizontal,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  Unplug,
} from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { CredentialStatusBadge } from "#web/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { SettingRow, SettingsSection } from "#web/components/trema/settings-section.tsx";
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
import { Checkbox } from "#web/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#web/components/ui/dropdown-menu.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { Switch } from "#web/components/ui/switch.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { scopeDisplayName } from "#web/lib/scopes.ts";
import {
  OAuthConnectionDialog,
  StaticConnectionDialog,
} from "#web/pages/settings/connectors/connection-dialogs.tsx";
import { RegistrationDialog } from "#web/pages/settings/connectors/registration-dialog.tsx";
import {
  type CatalogProvider,
  type ConnectorConnection,
  type ConnectorInstallation,
  type ConnectorMeta,
  messageFrom,
  providerLogo,
  type Registration,
  type Scope,
} from "#web/pages/settings/connectors/shared.tsx";

type DriftReport = { added: string[]; removed: string[]; changed: string[] };

export function SettingsConnectorDetailPage() {
  const { providerKey = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const connections = useQuery(
    orpc.connectors.connections.list.queryOptions({ input: { providerKey } }),
  );
  const installations = useQuery(orpc.connectors.installations.list.queryOptions({ input: {} }));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const registrations = useQuery(orpc.connectors.registrations.list.queryOptions({}));
  const meta = useQuery(orpc.connectors.meta.queryOptions({}));
  const provider = (catalog.data as CatalogProvider[] | undefined)?.find(
    (candidate) => candidate.key === providerKey,
  );
  const connectionRows = (connections.data ?? []) as ConnectorConnection[];
  const installationRows = ((installations.data ?? []) as ConnectorInstallation[]).filter(
    (installation) => installation.catalogKey === providerKey,
  );
  const scopeRows = ((scopes.data ?? []) as Scope[]).filter(
    (scope) => scope.kind === "org" || scope.kind === "shared",
  );
  const registrationRows = ((registrations.data ?? []) as Registration[]).filter(
    (registration) => registration.providerKey === providerKey,
  );
  const [connectOpen, setConnectOpen] = useState(false);
  const [staticOpen, setStaticOpen] = useState(false);
  const [reconnect, setReconnect] = useState<ConnectorConnection>();
  const [bindConnectionId, setBindConnectionId] = useState<string>();
  const [registrationOpen, setRegistrationOpen] = useState(false);
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

  useEffect(() => {
    const connectorError = searchParams.get("connector_error");
    if (connectorError) {
      toast.error(`Connection failed: ${connectorError.replaceAll("_", " ")}`);
      setSearchParams(
        (current) => {
          const next = new URLSearchParams(current);
          next.delete("connector_error");
          return next;
        },
        { replace: true },
      );
    }
    const connected = searchParams.get("connected");
    if (connected) setBindConnectionId(connected);
  }, [searchParams, setSearchParams]);

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.connectors.connections.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.connectors.installations.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.connectors.catalog.list.key() }),
    ]);
  }

  if (pending) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6 lg:p-8">
        <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
        {[1, 2, 3].map((key) => (
          <div key={key} className="h-48 animate-pulse rounded-lg border bg-muted/30" />
        ))}
      </main>
    );
  }
  if (error) {
    return (
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      </main>
    );
  }
  if (!provider) {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={Unplug}
          title="Connector not found"
          description="This provider is not in the connector catalog."
          action={
            <Button onClick={() => navigate("/settings/connectors")}>Back to connectors</Button>
          }
        />
      </main>
    );
  }
  const oauth = provider.authMode === "oauth2_code" || provider.authMode === "mcp_oauth";

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        leading={providerLogo(provider, "size-10")}
        title={provider.displayName}
        description="Manage provider accounts, scope availability, and per-scope tools."
      />
      <div className="space-y-7">
        <ConnectionsSection
          provider={provider}
          connections={connectionRows}
          installations={installationRows}
          scopes={scopeRows}
          onConnect={() => (oauth ? setConnectOpen(true) : setStaticOpen(true))}
          onReconnect={(connection) => {
            setReconnect(connection);
            if (oauth) setConnectOpen(true);
            else setStaticOpen(true);
          }}
          onAddToScope={setBindConnectionId}
          onChanged={invalidate}
        />
        {provider.authMode === "oauth2_code" ? (
          <AppCredentialsSection
            registrations={registrationRows}
            onManage={() => setRegistrationOpen(true)}
          />
        ) : null}
        <DangerZone
          provider={provider}
          installations={installationRows}
          connections={connectionRows}
          onChanged={async () => {
            await invalidate();
            navigate("/settings/connectors");
          }}
        />
      </div>
      {oauth ? (
        <OAuthConnectionDialog
          provider={provider}
          reconnect={reconnect}
          open={connectOpen}
          onOpenChange={(next) => {
            setConnectOpen(next);
            if (!next) setReconnect(undefined);
          }}
        />
      ) : null}
      <StaticConnectionDialog
        provider={provider}
        reconnect={reconnect}
        open={staticOpen}
        onOpenChange={(next) => {
          setStaticOpen(next);
          if (!next) setReconnect(undefined);
        }}
        onConnected={(connectionId) => {
          void invalidate();
          if (!reconnect) setBindConnectionId(connectionId);
        }}
      />
      <ScopeBindingDialog
        provider={provider}
        connectionId={bindConnectionId}
        scopes={scopeRows}
        installations={installationRows}
        open={bindConnectionId !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setBindConnectionId(undefined);
            setSearchParams(
              (current) => {
                const updated = new URLSearchParams(current);
                updated.delete("connected");
                return updated;
              },
              { replace: true },
            );
          }
        }}
        onChanged={invalidate}
      />
      <RegistrationDialog
        provider={provider}
        registrations={registrationRows}
        callbackUrl={(meta.data as ConnectorMeta).callbackUrl}
        open={registrationOpen}
        onOpenChange={setRegistrationOpen}
      />
    </main>
  );
}

function ConnectionsSection({
  provider,
  connections,
  installations,
  scopes,
  onConnect,
  onReconnect,
  onAddToScope,
  onChanged,
}: {
  provider: CatalogProvider;
  connections: ConnectorConnection[];
  installations: ConnectorInstallation[];
  scopes: Scope[];
  onConnect: () => void;
  onReconnect: (connection: ConnectorConnection) => void;
  onAddToScope: (connectionId: string) => void;
  onChanged: () => Promise<void>;
}) {
  const [showRevoked, setShowRevoked] = useState(false);
  const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
  const active = connections.filter((connection) => !connection.isRevoked);
  const revoked = connections.filter((connection) => connection.isRevoked);
  const boundScopeIds = new Set(installations.map((installation) => installation.scopeId));
  const canAddScope = scopes.some((scope) => !boundScopeIds.has(scope.id));
  const group = (connection: ConnectorConnection) => (
    <ConnectionGroup
      key={connection.id}
      provider={provider}
      connection={connection}
      bindings={installations.filter((installation) => installation.connectionId === connection.id)}
      scopesById={scopesById}
      canAddScope={canAddScope}
      onReconnect={() => onReconnect(connection)}
      onAddToScope={() => onAddToScope(connection.id)}
      onChanged={onChanged}
    />
  );
  return (
    <section data-slot="settings-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-chrome font-medium text-foreground">Connections</h3>
          <p className="mt-0.5 text-meta text-muted-foreground">
            Accounts the agent acts as, and where each one is available. Connect more than one to
            reach separate workspaces.
          </p>
        </div>
        <Button onClick={onConnect}>
          <Plus />
          Connect
        </Button>
      </div>
      <div className="mt-3 space-y-3">
        {active.length === 0 ? (
          <div className="rounded-md border bg-card px-4 py-5">
            <EmptyState
              title="Not connected"
              description={`Authorize the ${provider.displayName} account the agent should act as.`}
            />
          </div>
        ) : (
          active.map(group)
        )}
        {revoked.length > 0 ? (
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="text-muted-foreground"
              onClick={() => setShowRevoked((current) => !current)}
            >
              <ChevronDown className={showRevoked ? "rotate-180" : ""} />
              {showRevoked ? "Hide revoked" : `Show revoked (${revoked.length})`}
            </Button>
            {showRevoked ? (
              <div className="mt-2 space-y-3 opacity-75">{revoked.map(group)}</div>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}

function RenameConnectionDialog({
  connection,
  fallbackLabel,
  open,
  onOpenChange,
  onChanged,
}: {
  connection: ConnectorConnection;
  fallbackLabel: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [value, setValue] = useState(connection.label ?? "");
  useEffect(() => {
    if (open) setValue(connection.label ?? "");
  }, [open, connection.label]);
  const rename = useMutation({
    mutationFn: () => {
      const trimmed = value.trim();
      return rpcClient.connectors.connections.update({
        connectionId: connection.id,
        label: trimmed.length > 0 ? trimmed : null,
      });
    },
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success("Connection renamed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Rename connection</DialogTitle>
          <DialogDescription>
            A label helps tell accounts apart when a provider has more than one connected.
          </DialogDescription>
        </DialogHeader>
        <div className="my-4 space-y-2">
          <Label htmlFor={`rename-${connection.id}`}>Label</Label>
          <Input
            id={`rename-${connection.id}`}
            value={value}
            maxLength={60}
            placeholder={fallbackLabel}
            onChange={(event) => setValue(event.target.value)}
          />
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={rename.isPending} onClick={() => rename.mutate()}>
            {rename.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ConnectionGroup({
  provider,
  connection,
  bindings,
  scopesById,
  canAddScope,
  onReconnect,
  onAddToScope,
  onChanged,
}: {
  provider: CatalogProvider;
  connection: ConnectorConnection;
  bindings: ConnectorInstallation[];
  scopesById: Map<string, Scope>;
  canAddScope: boolean;
  onReconnect: () => void;
  onAddToScope: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const revoke = useMutation({
    mutationFn: () => rpcClient.connectors.connections.revoke({ connectionId: connection.id }),
    onSuccess: async () => {
      await onChanged();
      setConfirmRevoke(false);
      toast.success("Connection revoked");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const label = connection.label ?? provider.displayName;
  const status = connection.isValid ? "connected" : connection.isRevoked ? "expired" : "missing";
  const statusLabel = connection.isValid
    ? "Connected"
    : connection.isRevoked
      ? "Revoked"
      : "Reconnect needed";
  const reason = connection.isRevoked ? (
    <>Revoked {connection.revokedAt ? <RelativeTime date={connection.revokedAt} /> : null}</>
  ) : connection.refreshExhausted ? (
    "token refresh failing"
  ) : connection.isExpired ? (
    "token expired"
  ) : null;
  return (
    <div className="divide-y rounded-md border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="font-medium text-chrome">{label}</p>
          <p className="mt-0.5 text-meta text-muted-foreground">
            Connected <RelativeTime date={connection.createdAt} />
            {reason ? <> · {reason}</> : null}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <CredentialStatusBadge status={status} label={statusLabel} />
          {!connection.isValid ? (
            <Button size="sm" variant="outline" onClick={onReconnect}>
              <RefreshCw />
              Reconnect
            </Button>
          ) : null}
          {!connection.isRevoked ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button size="sm" variant="ghost" aria-label="Connection actions">
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setRenaming(true)}>Rename</DropdownMenuItem>
                <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRevoke(true)}>
                  Revoke connection
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </div>
      </div>
      <RenameConnectionDialog
        connection={connection}
        fallbackLabel={provider.displayName}
        open={renaming}
        onOpenChange={setRenaming}
        onChanged={onChanged}
      />
      {bindings.map((binding) => (
        <BindingRow
          key={binding.id}
          provider={provider}
          installation={binding}
          scope={scopesById.get(binding.scopeId)}
          onChanged={onChanged}
        />
      ))}
      {bindings.length === 0 || (connection.isValid && canAddScope) ? (
        <div className="flex flex-wrap items-center justify-between gap-3 py-2 pr-4 pl-9">
          {bindings.length === 0 ? (
            <p className="text-meta text-muted-foreground">Not available in any scope yet</p>
          ) : (
            <span />
          )}
          {connection.isValid && canAddScope ? (
            <Button
              size="sm"
              variant="ghost"
              className="text-muted-foreground"
              onClick={onAddToScope}
            >
              <Plus />
              Add to scope
            </Button>
          ) : null}
        </div>
      ) : null}
      <AlertDialog open={confirmRevoke} onOpenChange={setConfirmRevoke}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this connection?</AlertDialogTitle>
            <AlertDialogDescription>
              Every scope bound to it will stop working until its binding uses another connection.
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
    </div>
  );
}

function BindingRow({
  provider,
  installation,
  scope,
  onChanged,
}: {
  provider: CatalogProvider;
  installation: ConnectorInstallation;
  scope?: Scope | undefined;
  onChanged: () => Promise<void>;
}) {
  const [configure, setConfigure] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [report, setReport] = useState<DriftReport>();
  const total =
    provider.transport.type === "rest"
      ? (provider.toolManifest?.length ?? 0)
      : installation.syncedTools.length;
  const summary = [
    installation.enabledTools === "all"
      ? "All tools"
      : `${installation.enabledTools.length} of ${total} tools`,
    provider.transport.type === "mcp" ? `${installation.syncedTools.length} synced` : undefined,
  ]
    .filter(Boolean)
    .join(" · ");
  const sync = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.sync({ installationItemId: installation.id }),
    onSuccess: async (result) => {
      setReport(result.report);
      await onChanged();
      toast.success("Tools synced");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const archive = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.archive({ installationItemId: installation.id }),
    onSuccess: async () => {
      await onChanged();
      setConfirmRemove(false);
      toast.success("Removed from scope");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <div className="py-3 pr-4 pl-9">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="min-w-0">
          <p className="text-chrome">{scope ? scopeDisplayName(scope) : installation.scopeId}</p>
          <p className="mt-0.5 text-meta text-muted-foreground">{summary}</p>
        </div>
        <div className="flex items-center gap-2">
          <Button size="xs" variant="outline" onClick={() => setConfigure(true)}>
            <Settings2 />
            Configure tools
          </Button>
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button size="sm" variant="ghost" aria-label="Scope binding actions">
                <MoreHorizontal className={sync.isPending ? "animate-pulse" : ""} />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="end">
              {provider.transport.type === "mcp" ? (
                <DropdownMenuItem disabled={sync.isPending} onSelect={() => sync.mutate()}>
                  <RefreshCw />
                  Sync tools now
                </DropdownMenuItem>
              ) : null}
              <DropdownMenuItem variant="destructive" onSelect={() => setConfirmRemove(true)}>
                <Trash2 />
                Remove from scope
              </DropdownMenuItem>
            </DropdownMenuContent>
          </DropdownMenu>
        </div>
      </div>
      {report ? <DriftReportView report={report} /> : null}
      <ConfigureToolsDialog
        provider={provider}
        installation={installation}
        open={configure}
        onOpenChange={setConfigure}
        onChanged={onChanged}
      />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this scope binding?</AlertDialogTitle>
            <AlertDialogDescription>
              The installation is archived. Its connection remains available to other scopes.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archive.isPending}
              onClick={() => archive.mutate()}
            >
              {archive.isPending ? "Removing…" : "Remove"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ConfigureToolsDialog({
  provider,
  installation,
  open,
  onOpenChange,
  onChanged,
}: {
  provider: CatalogProvider;
  installation: ConnectorInstallation;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const available =
    provider.transport.type === "rest" ? (provider.toolManifest ?? []) : installation.syncedTools;
  const [search, setSearch] = useState("");
  const [allTools, setAllTools] = useState(installation.enabledTools === "all");
  const [enabled, setEnabled] = useState<string[]>(
    installation.enabledTools === "all"
      ? available.map((tool) => tool.name)
      : installation.enabledTools,
  );
  useEffect(() => {
    if (!open) return;
    setSearch("");
    setAllTools(installation.enabledTools === "all");
    setEnabled(
      installation.enabledTools === "all"
        ? available.map((tool) => tool.name)
        : installation.enabledTools,
    );
  }, [open, installation, available]);
  const filtered = available.filter((tool) =>
    `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const save = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.update({
        installationItemId: installation.id,
        enabledTools: allTools ? "all" : enabled,
      }),
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success("Tool configuration saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure tools</DialogTitle>
          <DialogDescription>
            Tool choices apply only to this scope binding. Whether a call pauses for approval is the
            session&apos;s approval mode, bounded by policy.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <div className="rounded-md border">
            <SettingRow
              label="All tools"
              description="New synced tools arrive enabled while this is on."
              control={
                <Switch
                  checked={allTools}
                  onCheckedChange={(checked) => {
                    setAllTools(checked);
                    if (!checked) setEnabled(available.map((tool) => tool.name));
                  }}
                />
              }
            />
          </div>
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tools"
          />
          <div className="divide-y rounded-md border">
            {filtered.map((tool) => (
              <div key={tool.name} className="px-3 py-3">
                <label
                  htmlFor={`tool-enabled-${installation.id}-${tool.name}`}
                  className="flex min-w-0 items-start gap-3"
                >
                  <Checkbox
                    id={`tool-enabled-${installation.id}-${tool.name}`}
                    checked={allTools || enabled.includes(tool.name)}
                    disabled={allTools}
                    onCheckedChange={(checked) =>
                      setEnabled((current) =>
                        checked
                          ? [...current, tool.name]
                          : current.filter((name) => name !== tool.name),
                      )
                    }
                  />
                  <span className="min-w-0">
                    <span className="block font-medium text-chrome">{tool.name}</span>
                    <span className="block truncate text-meta text-muted-foreground">
                      {tool.description ?? "No description provided."}
                    </span>
                  </span>
                </label>
              </div>
            ))}
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ScopeBindingDialog({
  provider,
  connectionId,
  scopes,
  installations,
  open,
  onOpenChange,
  onChanged,
}: {
  provider: CatalogProvider;
  connectionId?: string | undefined;
  scopes: Scope[];
  installations: ConnectorInstallation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const boundScopeIds = new Set(installations.map((installation) => installation.scopeId));
  const choices = scopes.filter((scope) => !boundScopeIds.has(scope.id));
  const orgScope = choices.find((scope) => scope.kind === "org");
  const [selected, setSelected] = useState<string[]>([]);
  useEffect(() => {
    if (open) setSelected(installations.length === 0 && orgScope ? [orgScope.id] : []);
  }, [open, installations.length, orgScope]);
  const bind = useMutation({
    mutationFn: async () => {
      if (!connectionId) throw new Error("Connection is required");
      await Promise.all(
        selected.map((scopeId) =>
          rpcClient.connectors.installations.create({
            scopeId,
            catalogKey: provider.key,
            connectionId,
            enabledTools: "all",
          }),
        ),
      );
    },
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success(selected.length === 1 ? "Added to scope" : "Added to scopes");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add {provider.displayName} to scopes</DialogTitle>
          <DialogDescription>
            Each selected scope gets its own installation with all tools enabled.
          </DialogDescription>
        </DialogHeader>
        <div className="max-h-72 space-y-2 overflow-y-auto rounded-md border p-3">
          {choices.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              This provider is already in every scope.
            </p>
          ) : (
            choices.map((scope) => (
              <label
                key={scope.id}
                htmlFor={`binding-scope-${scope.id}`}
                className="flex items-center gap-2"
              >
                <Checkbox
                  id={`binding-scope-${scope.id}`}
                  checked={selected.includes(scope.id)}
                  onCheckedChange={(checked) =>
                    setSelected((current) =>
                      checked
                        ? [...current, scope.id]
                        : current.filter((scopeId) => scopeId !== scope.id),
                    )
                  }
                />
                {scopeDisplayName(scope)}
              </label>
            ))
          )}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Skip
          </Button>
          <Button disabled={selected.length === 0 || bind.isPending} onClick={() => bind.mutate()}>
            {bind.isPending ? "Adding…" : "Add to selected scopes"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function AppCredentialsSection({
  registrations,
  onManage,
}: {
  registrations: Registration[];
  onManage: () => void;
}) {
  const usable = registrations.some((registration) => registration.isUsable);
  return (
    <SettingsSection
      title="App credentials"
      description="The OAuth app identity used to mint provider tokens."
    >
      <SettingRow
        label={usable ? "OAuth app configured" : "OAuth app needs setup"}
        description={
          usable
            ? "A customer or platform registration is available."
            : "Add a client id and secret before connecting."
        }
        control={
          <Button variant="outline" onClick={onManage}>
            Manage
          </Button>
        }
      />
    </SettingsSection>
  );
}

function DangerZone({
  provider,
  installations,
  connections,
  onChanged,
}: {
  provider: CatalogProvider;
  installations: ConnectorInstallation[];
  connections: ConnectorConnection[];
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const disconnect = useMutation({
    mutationFn: async () => {
      await Promise.all([
        ...installations.map((installation) =>
          rpcClient.connectors.installations.archive({ installationItemId: installation.id }),
        ),
        ...connections
          .filter((connection) => !connection.isRevoked)
          .map((connection) =>
            rpcClient.connectors.connections.revoke({ connectionId: connection.id }),
          ),
      ]);
    },
    onSuccess: async () => {
      await onChanged();
      toast.success(`${provider.displayName} disconnected`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <SettingsSection
      title="Danger zone"
      description="Remove every scope binding and revoke every connection. App credentials are kept."
    >
      <SettingRow
        label={`Disconnect ${provider.displayName}`}
        control={
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            <Unplug />
            Disconnect
          </Button>
        }
      />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Disconnect {provider.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This archives all bindings and revokes all provider connections for the organization.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={disconnect.isPending}
              onClick={() => disconnect.mutate()}
            >
              {disconnect.isPending ? "Disconnecting…" : `Disconnect ${provider.displayName}`}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function DriftReportView({ report }: { report: DriftReport }) {
  const changes = [
    ...report.added.map((name) => `Added: ${name}`),
    ...report.removed.map((name) => `Removed: ${name}`),
    ...report.changed.map((name) => `Changed: ${name}`),
  ];
  return (
    <div className="mt-3 rounded-md bg-muted/40 p-2 text-meta text-muted-foreground">
      {changes.length === 0 ? "No tool changes found." : changes.join(" · ")}
    </div>
  );
}
