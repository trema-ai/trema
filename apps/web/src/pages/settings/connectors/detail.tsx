import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Plus, RefreshCw, Settings2, Trash2, Unplug } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";
import { CredentialStatusBadge } from "#/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { ScopeBadge } from "#/components/trema/scope-badge.tsx";
import { SensitivityBadge } from "#/components/trema/sensitivity-badge.tsx";
import { SettingRow, SettingsSection } from "#/components/trema/settings-section.tsx";
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
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { scopeDisplayName } from "#/lib/scopes.ts";
import {
  OAuthConnectionDialog,
  StaticConnectionDialog,
} from "#/pages/settings/connectors/connection-dialogs.tsx";
import { RegistrationDialog } from "#/pages/settings/connectors/registration-dialog.tsx";
import {
  authModeLabel,
  type CatalogProvider,
  type ConnectorConnection,
  type ConnectorInstallation,
  type ConnectorMeta,
  messageFrom,
  providerLogo,
  type Registration,
  type Scope,
  type Sensitivity,
} from "#/pages/settings/connectors/shared.tsx";

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
  const [addBindingOpen, setAddBindingOpen] = useState(false);
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
        title={
          <span className="flex items-center gap-3">
            {providerLogo(provider, "size-9")}
            {provider.displayName}
          </span>
        }
        description="Manage provider accounts, scope availability, and per-scope tools."
        actions={
          <Button variant="outline" onClick={() => navigate("/settings/connectors")}>
            <ArrowLeft />
            Connectors
          </Button>
        }
      />
      <div className="space-y-7">
        <ConnectionsSection
          provider={provider}
          connections={connectionRows}
          scopes={scopeRows}
          onConnect={() => (oauth ? setConnectOpen(true) : setStaticOpen(true))}
          onReconnect={(connection) => {
            setReconnect(connection);
            if (oauth) setConnectOpen(true);
            else setStaticOpen(true);
          }}
          onChanged={invalidate}
        />
        <AvailabilitySection
          provider={provider}
          installations={installationRows}
          connections={connectionRows}
          scopes={scopeRows}
          onAdd={() => setAddBindingOpen(true)}
          onChanged={invalidate}
        />
        {provider.memberConnectable ? (
          <MemberAccessSection provider={provider} onChanged={invalidate} />
        ) : null}
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
      <AddBindingDialog
        provider={provider}
        scopes={scopeRows}
        connections={connectionRows.filter((connection) => connection.isValid)}
        installations={installationRows}
        open={addBindingOpen}
        onOpenChange={setAddBindingOpen}
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
  scopes,
  onConnect,
  onReconnect,
  onChanged,
}: {
  provider: CatalogProvider;
  connections: ConnectorConnection[];
  scopes: Scope[];
  onConnect: () => void;
  onReconnect: (connection: ConnectorConnection) => void;
  onChanged: () => Promise<void>;
}) {
  const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
  return (
    <SettingsSection
      title="Connections"
      description="Provider accounts authorized for the organization agent. Secret values are never shown."
    >
      {connections.length === 0 ? (
        <div className="px-4 py-5">
          <EmptyState
            title="Not connected"
            description={`Authorize the ${provider.displayName} account the agent should act as.`}
          />
        </div>
      ) : (
        connections.map((connection) => (
          <ConnectionRow
            key={connection.id}
            provider={provider}
            connection={connection}
            scopesById={scopesById}
            onReconnect={() => onReconnect(connection)}
            onChanged={onChanged}
          />
        ))
      )}
      <div className="flex justify-end px-4 py-3.5">
        <Button onClick={onConnect}>
          <Plus />
          Connect
        </Button>
      </div>
    </SettingsSection>
  );
}

function ConnectionRow({
  provider,
  connection,
  scopesById,
  onReconnect,
  onChanged,
}: {
  provider: CatalogProvider;
  connection: ConnectorConnection;
  scopesById: Map<string, Scope>;
  onReconnect: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const revoke = useMutation({
    mutationFn: () => rpcClient.connectors.connections.revoke({ connectionId: connection.id }),
    onSuccess: async () => {
      await onChanged();
      setConfirm(false);
      toast.success("Connection revoked");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const label = connection.label ?? provider.displayName;
  const statusLabel = connection.isRevoked
    ? "Revoked"
    : connection.isExpired
      ? "Expired"
      : connection.refreshExhausted
        ? "Reconnect needed"
        : "Connected";
  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
      <div className="min-w-0">
        <p className="font-medium text-chrome">{label}</p>
        <p className="mt-0.5 text-meta text-muted-foreground">
          {authModeLabel(connection.mode)} · Created <RelativeTime date={connection.createdAt} />
          {connection.expiresAt ? (
            <>
              {" "}
              · Expires <RelativeTime date={connection.expiresAt} />
            </>
          ) : null}
        </p>
        {connection.installations.length > 0 ? (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {connection.installations.map((installation) => {
              const scope = scopesById.get(installation.scopeId);
              return (
                <ScopeBadge
                  key={installation.id}
                  scope={scope ? scopeDisplayName(scope) : installation.scopeId}
                />
              );
            })}
          </div>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <CredentialStatusBadge
          status={connection.isValid ? "connected" : "expired"}
          label={statusLabel}
        />
        {!connection.isValid ? (
          <Button size="sm" variant="outline" onClick={onReconnect}>
            <RefreshCw />
            Reconnect
          </Button>
        ) : null}
        {!connection.isRevoked ? (
          <Button size="sm" variant="destructive" onClick={() => setConfirm(true)}>
            Revoke
          </Button>
        ) : null}
      </div>
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
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

function AvailabilitySection({
  provider,
  installations,
  connections,
  scopes,
  onAdd,
  onChanged,
}: {
  provider: CatalogProvider;
  installations: ConnectorInstallation[];
  connections: ConnectorConnection[];
  scopes: Scope[];
  onAdd: () => void;
  onChanged: () => Promise<void>;
}) {
  const connectionsById = new Map(connections.map((connection) => [connection.id, connection]));
  const scopesById = new Map(scopes.map((scope) => [scope.id, scope]));
  return (
    <SettingsSection
      title="Availability & tools"
      description="Each binding chooses a scope, connection, tool allowlist, and sensitivity overrides."
    >
      {installations.length === 0 ? (
        <div className="px-4 py-5">
          <EmptyState title="Not available in any scope" />
        </div>
      ) : (
        installations.map((installation) => (
          <InstallationRow
            key={installation.id}
            provider={provider}
            installation={installation}
            connection={connectionsById.get(installation.connectionId)}
            scope={scopesById.get(installation.scopeId)}
            onChanged={onChanged}
          />
        ))
      )}
      <div className="flex justify-end px-4 py-3.5">
        <Button variant="outline" onClick={onAdd} disabled={connections.length === 0}>
          <Plus />
          Add to scope
        </Button>
      </div>
    </SettingsSection>
  );
}

function InstallationRow({
  provider,
  installation,
  connection,
  scope,
  onChanged,
}: {
  provider: CatalogProvider;
  installation: ConnectorInstallation;
  connection?: ConnectorConnection | undefined;
  scope?: Scope | undefined;
  onChanged: () => Promise<void>;
}) {
  const [configure, setConfigure] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [report, setReport] = useState<DriftReport>();
  const total =
    provider.transport.type === "rest"
      ? (provider.toolManifest?.length ?? 0)
      : installation.syncedTools.length;
  const summary =
    installation.enabledTools === "all"
      ? "All tools"
      : `${installation.enabledTools.length} of ${total}`;
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
      setConfirm(false);
      toast.success("Scope binding removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <div className="px-4 py-3.5">
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <div className="flex items-center gap-2">
            <ScopeBadge scope={scope ? scopeDisplayName(scope) : installation.scopeId} />
            <span className="font-medium text-chrome">
              {connection?.label ?? provider.displayName}
            </span>
          </div>
          <p className="mt-1 text-meta text-muted-foreground">{summary}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => setConfigure(true)}>
            <Settings2 />
            Configure
          </Button>
          {provider.transport.type === "mcp" ? (
            <Button
              size="sm"
              variant="outline"
              disabled={sync.isPending}
              onClick={() => sync.mutate()}
            >
              <RefreshCw className={sync.isPending ? "animate-spin" : ""} />
              Sync now
            </Button>
          ) : null}
          <Button size="sm" variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2 />
            Remove
          </Button>
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
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
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
  const [overrides, setOverrides] = useState<Record<string, Sensitivity>>(
    installation.sensitivityOverrides,
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
    setOverrides(installation.sensitivityOverrides);
  }, [open, installation, available]);
  const filtered = available.filter((tool) =>
    `${tool.name} ${tool.description ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  const save = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.update({
        installationItemId: installation.id,
        enabledTools: allTools ? "all" : enabled,
        sensitivityOverrides: overrides,
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
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>Configure tools</DialogTitle>
          <DialogDescription>
            Tool choices and sensitivity overrides apply only to this scope binding.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
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
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search tools"
          />
          <div className="divide-y rounded-md border">
            {filtered.map((tool) => {
              const sensitivity = overrides[tool.name] ?? tool.sensitivity;
              return (
                <div
                  key={tool.name}
                  className="grid gap-3 px-3 py-3 sm:grid-cols-[1fr_auto_auto] sm:items-center"
                >
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
                      <span className="block text-meta text-muted-foreground">
                        {tool.description ?? "No description provided."}
                      </span>
                    </span>
                  </label>
                  <SensitivityBadge sensitivity={sensitivity} />
                  <Select
                    value={sensitivity}
                    onValueChange={(value) =>
                      setOverrides((current) => ({
                        ...current,
                        [tool.name]: value as Sensitivity,
                      }))
                    }
                  >
                    <SelectTrigger className="w-36">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="read">Read</SelectItem>
                      <SelectItem value="write">Write</SelectItem>
                      <SelectItem value="destructive">Destructive</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              );
            })}
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
                <ScopeBadge scope={scopeDisplayName(scope)} />
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

function AddBindingDialog({
  provider,
  scopes,
  connections,
  installations,
  open,
  onOpenChange,
  onChanged,
}: {
  provider: CatalogProvider;
  scopes: Scope[];
  connections: ConnectorConnection[];
  installations: ConnectorInstallation[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const bound = new Set(installations.map((installation) => installation.scopeId));
  const availableScopes = scopes.filter((scope) => !bound.has(scope.id));
  const [scopeId, setScopeId] = useState("");
  const [connectionId, setConnectionId] = useState("");
  useEffect(() => {
    if (!open) return;
    setScopeId(availableScopes[0]?.id ?? "");
    setConnectionId(connections[0]?.id ?? "");
  }, [open, availableScopes, connections]);
  const create = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.create({
        scopeId,
        catalogKey: provider.key,
        connectionId,
        enabledTools: "all",
      }),
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success("Scope binding created");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add to scope</DialogTitle>
          <DialogDescription>
            Choose the scope and provider account it should use.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Scope</Label>
            <Select value={scopeId} onValueChange={setScopeId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a scope" />
              </SelectTrigger>
              <SelectContent>
                {availableScopes.map((scope) => (
                  <SelectItem key={scope.id} value={scope.id}>
                    {scopeDisplayName(scope)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Connection</Label>
            <Select value={connectionId} onValueChange={setConnectionId}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Choose a connection" />
              </SelectTrigger>
              <SelectContent>
                {connections.map((connection) => (
                  <SelectItem key={connection.id} value={connection.id}>
                    {connection.label ?? provider.displayName} · {connection.id.slice(0, 8)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={!scopeId || !connectionId || create.isPending}
            onClick={() => create.mutate()}
          >
            {create.isPending ? "Adding…" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function MemberAccessSection({
  provider,
  onChanged,
}: {
  provider: CatalogProvider;
  onChanged: () => Promise<void>;
}) {
  const update = useMutation({
    mutationFn: (memberEnabled: boolean) =>
      rpcClient.connectors.providers.updateSettings({
        providerKey: provider.key,
        memberEnabled,
      }),
    onSuccess: async () => {
      await onChanged();
      toast.success("Member access updated");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <SettingsSection
      title="Member access"
      description="Allow members to connect this provider to their own personal scopes."
    >
      <SettingRow
        label="Allow personal connections"
        description="Members still authorize their own provider accounts."
        control={
          <Switch
            checked={provider.memberEnabled}
            disabled={update.isPending}
            onCheckedChange={(checked) => update.mutate(checked)}
          />
        }
      />
    </SettingsSection>
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
