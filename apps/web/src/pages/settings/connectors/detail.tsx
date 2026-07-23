import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, KeyRound, RefreshCw, Settings2, Trash2, Unplug } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router";
import { toast } from "sonner";

import { CredentialStatusBadge } from "#/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { KeyValueList } from "#/components/trema/key-value-list.tsx";
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
import { RegistrationDialog } from "#/pages/settings/connectors/registration-dialog.tsx";
import {
  authModeLabel,
  type CatalogProvider,
  type ConnectorInstallation,
  type CredentialSummary,
  type FieldDescriptor,
  messageFrom,
  providerLogo,
  type Registration,
  type Scope,
  type Sensitivity,
} from "#/pages/settings/connectors/shared.tsx";

type ConnectorMeta = {
  callbackUrl: string;
  principals: Array<{ id: string; displayName: string; kind: "human" | "agent" }>;
};

type DriftReport = { added: string[]; removed: string[]; changed: string[] };

export function SettingsConnectorDetailPage() {
  const { installationItemId = "" } = useParams();
  const navigate = useNavigate();
  const [searchParams, setSearchParams] = useSearchParams();
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const installations = useQuery(orpc.connectors.installations.list.queryOptions({ input: {} }));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const registrations = useQuery(orpc.connectors.registrations.list.queryOptions({}));
  const meta = useQuery(orpc.connectors.meta.queryOptions({}));
  const installation = (installations.data as ConnectorInstallation[] | undefined)?.find(
    (candidate) => candidate.id === installationItemId,
  );
  const provider = (catalog.data as CatalogProvider[] | undefined)?.find(
    (candidate) => candidate.key === installation?.catalogKey,
  );
  const scope = (scopes.data as Scope[] | undefined)?.find(
    (candidate) => candidate.id === installation?.scopeId,
  );
  const providerRegistrations = ((registrations.data ?? []) as Registration[]).filter(
    (registration) => registration.providerKey === provider?.key,
  );
  const error =
    catalog.error ?? installations.error ?? scopes.error ?? registrations.error ?? meta.error;
  const pending =
    catalog.isPending ||
    installations.isPending ||
    scopes.isPending ||
    registrations.isPending ||
    meta.isPending;

  useEffect(() => {
    const connectorError = searchParams.get("connector_error");
    if (!connectorError) return;
    toast.error(`Connection failed: ${connectorError.replaceAll("_", " ")}`);
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.delete("connector_error");
      return next;
    });
  }, [searchParams, setSearchParams]);

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
  if (!installation || !provider) {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={Unplug}
          title="Connector not found"
          description="This installation may have been uninstalled."
          action={
            <Button onClick={() => navigate("/settings/connectors")}>Back to connectors</Button>
          }
        />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={
          <span className="flex items-center gap-3">
            {providerLogo(provider, "size-9")}
            {provider.displayName}
          </span>
        }
        description={`Installed in ${scope ? scopeDisplayName(scope) : "this scope"}.`}
        actions={
          <Button variant="outline" onClick={() => navigate("/settings/connectors")}>
            <ArrowLeft />
            Connectors
          </Button>
        }
      />
      <div className="space-y-7">
        <ToolsSection installation={installation} provider={provider} />
        <CredentialsSection
          installation={installation}
          provider={provider}
          meta={meta.data as ConnectorMeta}
        />
        <ConnectorSettingsSection
          installation={installation}
          provider={provider}
          scope={scope}
          registrations={providerRegistrations}
          callbackUrl={(meta.data as ConnectorMeta).callbackUrl}
        />
      </div>
    </main>
  );
}

function ToolsSection({
  installation,
  provider,
}: {
  installation: ConnectorInstallation;
  provider: CatalogProvider;
}) {
  const queryClient = useQueryClient();
  const availableTools =
    provider.transport.type === "rest" ? (provider.toolManifest ?? []) : installation.syncedTools;
  const [allTools, setAllTools] = useState(installation.enabledTools === "all");
  const [enabledTools, setEnabledTools] = useState<string[]>(
    installation.enabledTools === "all"
      ? availableTools.map((tool) => tool.name)
      : installation.enabledTools,
  );
  const [overrides, setOverrides] = useState<Record<string, Sensitivity>>(
    installation.sensitivityOverrides,
  );
  const [report, setReport] = useState<DriftReport>();
  const installationKey = orpc.connectors.installations.list.queryOptions({
    input: {},
  }).queryKey;
  useEffect(() => {
    setAllTools(installation.enabledTools === "all");
    setEnabledTools(
      installation.enabledTools === "all"
        ? availableTools.map((tool) => tool.name)
        : installation.enabledTools,
    );
    setOverrides(installation.sensitivityOverrides);
  }, [installation, availableTools]);

  const save = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.update({
        installationItemId: installation.id,
        enabledTools: allTools ? "all" : enabledTools,
        sensitivityOverrides: overrides,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: installationKey });
      toast.success("Connector tools updated");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const sync = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.sync({
        installationItemId: installation.id,
      }),
    onSuccess: async (result) => {
      setReport(result.report);
      await queryClient.invalidateQueries({ queryKey: installationKey });
      toast.success("Connector tools synced");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  return (
    <SettingsSection
      title="Tools"
      description="Choose the tools this connector exposes and adjust their sensitivity."
    >
      <SettingRow
        label="All tools"
        description="New tools are enabled automatically when this setting is on."
        control={
          <Switch
            checked={allTools}
            onCheckedChange={(checked) => {
              setAllTools(checked);
              if (!checked) setEnabledTools(availableTools.map((tool) => tool.name));
            }}
          />
        }
      />
      <div className="divide-y">
        {availableTools.length === 0 ? (
          <div className="p-5 text-center text-meta text-muted-foreground">
            {provider.transport.type === "mcp"
              ? "Sync this connector to load its tools."
              : "This connector has no tools."}
          </div>
        ) : (
          availableTools.map((tool) => {
            const enabled = allTools || enabledTools.includes(tool.name);
            const sensitivity = overrides[tool.name] ?? tool.sensitivity;
            return (
              <div
                key={tool.name}
                className="grid gap-3 px-4 py-3.5 sm:grid-cols-[1fr_auto_auto] sm:items-center"
              >
                <label
                  htmlFor={`tool-enabled-${tool.name}`}
                  className="flex min-w-0 items-start gap-3"
                >
                  <Checkbox
                    id={`tool-enabled-${tool.name}`}
                    checked={enabled}
                    disabled={allTools}
                    onCheckedChange={(checked) =>
                      setEnabledTools((current) =>
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
                  <SelectTrigger className="w-36" aria-label={`Sensitivity for ${tool.name}`}>
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
          })
        )}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
        <div>{report ? <DriftReportView report={report} /> : null}</div>
        <div className="flex gap-2">
          {provider.transport.type === "mcp" ? (
            <Button variant="outline" disabled={sync.isPending} onClick={() => sync.mutate()}>
              <RefreshCw className={sync.isPending ? "animate-spin" : ""} />
              {sync.isPending ? "Syncing…" : "Sync now"}
            </Button>
          ) : null}
          <Button disabled={save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save tools"}
          </Button>
        </div>
      </div>
    </SettingsSection>
  );
}

function DriftReportView({ report }: { report: DriftReport }) {
  const changes = [
    ...report.added.map((name) => ({ name, label: "Added" })),
    ...report.removed.map((name) => ({ name, label: "Removed" })),
    ...report.changed.map((name) => ({ name, label: "Changed" })),
  ];
  if (changes.length === 0)
    return <p className="text-meta text-muted-foreground">No tool changes found.</p>;
  return (
    <div>
      <p className="text-chrome font-medium">Tool changes</p>
      <ul className="mt-1 space-y-1 text-meta">
        {changes.map((change) => (
          <li key={`${change.label}-${change.name}`}>
            <span className="text-muted-foreground">{change.label}:</span> {change.name}
          </li>
        ))}
      </ul>
    </div>
  );
}

function CredentialsSection({
  installation,
  provider,
  meta,
}: {
  installation: ConnectorInstallation;
  provider: CatalogProvider;
  meta: ConnectorMeta;
}) {
  const [staticOpen, setStaticOpen] = useState(false);
  const [principalId, setPrincipalId] = useState(meta.principals[0]?.id ?? "");
  const startOAuth = useMutation({
    mutationFn: () =>
      rpcClient.connectors.connect.startOAuth({
        installationItemId: installation.id,
        providerKey: provider.key,
        principalId,
        returnTo: window.location.href,
      }),
    onSuccess: ({ authorizationUrl }) => {
      window.location.assign(authorizationUrl);
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const isOAuth = ["oauth2_code", "mcp_oauth"].includes(provider.authMode);
  const isStatic = ["api_key", "basic"].includes(provider.authMode);

  return (
    <SettingsSection
      title="Credentials"
      description="Credential values are encrypted and never shown here."
    >
      {installation.credentials.length === 0 ? (
        <div className="px-4 py-5">
          <EmptyState
            icon={KeyRound}
            title="Not connected"
            description="Connect a principal to make this installation usable."
          />
        </div>
      ) : (
        installation.credentials.map((credential) => (
          <CredentialRow
            key={credential.id}
            credential={credential}
            installationId={installation.id}
          />
        ))
      )}
      {(isOAuth || isStatic) && meta.principals.length > 0 ? (
        <div className="flex flex-wrap items-end justify-between gap-3 px-4 py-3.5">
          <div className="w-full max-w-xs space-y-2">
            <Label htmlFor="connector-principal">Connect as</Label>
            <Select value={principalId} onValueChange={setPrincipalId}>
              <SelectTrigger id="connector-principal" className="w-full">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {meta.principals.map((principal) => (
                  <SelectItem key={principal.id} value={principal.id}>
                    {principal.kind === "agent"
                      ? "Agent (service)"
                      : `${principal.displayName} (you)`}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <Button
            disabled={!principalId || startOAuth.isPending}
            onClick={() => (isOAuth ? startOAuth.mutate() : setStaticOpen(true))}
          >
            {startOAuth.isPending ? "Starting…" : "Connect"}
          </Button>
        </div>
      ) : null}
      <StaticCredentialDialog
        open={staticOpen}
        onOpenChange={setStaticOpen}
        installation={installation}
        provider={provider}
        principalId={principalId}
      />
    </SettingsSection>
  );
}

function CredentialRow({
  credential,
  installationId,
}: {
  credential: CredentialSummary;
  installationId: string;
}) {
  const queryClient = useQueryClient();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const key = orpc.connectors.installations.list.queryOptions({ input: {} }).queryKey;
  const revoke = useMutation({
    mutationFn: () =>
      rpcClient.connectors.credentials.revoke({
        installationItemId: installationId,
        credentialId: credential.id,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: key });
      setConfirmOpen(false);
      toast.success("Credential revoked");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const status = credential.isValid ? "connected" : "expired";
  const label = credential.isRevoked
    ? "Revoked"
    : credential.isExpired
      ? "Expired"
      : credential.isValid
        ? "Connected"
        : "Reconnect needed";

  return (
    <div className="flex flex-wrap items-center justify-between gap-4 px-4 py-3.5">
      <div>
        <p className="font-medium text-chrome">{credential.principalName}</p>
        <p className="mt-0.5 text-meta text-muted-foreground">
          {authModeLabel(credential.mode)} · Created <RelativeTime date={credential.createdAt} />
          {credential.expiresAt ? (
            <>
              {" "}
              · Expires <RelativeTime date={credential.expiresAt} />
            </>
          ) : null}
        </p>
      </div>
      <div className="flex items-center gap-3">
        <CredentialStatusBadge status={status} label={label} />
        {!credential.isRevoked ? (
          <Button variant="destructive" size="sm" onClick={() => setConfirmOpen(true)}>
            <Trash2 />
            Revoke
          </Button>
        ) : null}
      </div>
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke this credential?</AlertDialogTitle>
            <AlertDialogDescription>
              This principal will no longer be able to use the connector with this credential.
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
    </div>
  );
}

function StaticCredentialDialog({
  open,
  onOpenChange,
  installation,
  provider,
  principalId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  installation: ConnectorInstallation;
  provider: CatalogProvider;
  principalId: string;
}) {
  const queryClient = useQueryClient();
  const initialValues = useMemo(
    () =>
      Object.fromEntries(
        [
          ...Object.entries(provider.configFields),
          ...Object.entries(provider.credentialFields),
        ].map(([name, descriptor]) => [
          name,
          String(installation.config[name] ?? descriptor.default ?? ""),
        ]),
      ),
    [installation.config, provider],
  );
  const [values, setValues] = useState<Record<string, string>>(initialValues);
  const [inlineError, setInlineError] = useState<string>();
  const installationKey = orpc.connectors.installations.list.queryOptions({
    input: {},
  }).queryKey;
  useEffect(() => setValues(initialValues), [initialValues]);
  const create = useMutation({
    mutationFn: () =>
      rpcClient.connectors.connect.createStatic({
        installationItemId: installation.id,
        providerKey: provider.key,
        principalId,
        credentials: Object.fromEntries(
          Object.keys(provider.credentialFields).map((name) => [name, values[name] ?? ""]),
        ),
        ...(Object.keys(provider.configFields).length > 0
          ? {
              config: Object.fromEntries(
                Object.keys(provider.configFields).map((name) => [name, values[name] ?? ""]),
              ),
            }
          : {}),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: installationKey });
      setInlineError(undefined);
      onOpenChange(false);
      toast.success("Credential connected");
    },
    onError: (cause) => {
      const message = messageFrom(cause);
      setInlineError(message);
      toast.error(message);
    },
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setInlineError(undefined);
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit} className="contents">
          <DialogHeader>
            <DialogTitle>Connect {provider.displayName}</DialogTitle>
            <DialogDescription>
              Enter the provider credentials. Secret values are write-only.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {inlineError ? (
              <Alert variant="destructive">
                <AlertDescription>{inlineError}</AlertDescription>
              </Alert>
            ) : null}
            {Object.keys(provider.configFields).length > 0 ? (
              <DescriptorFields
                fields={provider.configFields}
                values={values}
                onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
              />
            ) : null}
            <DescriptorFields
              fields={provider.credentialFields}
              values={values}
              onChange={(name, value) => setValues((current) => ({ ...current, [name]: value }))}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={create.isPending}>
              {create.isPending ? "Verifying…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function DescriptorFields({
  fields,
  values,
  onChange,
}: {
  fields: Record<string, FieldDescriptor>;
  values: Record<string, string>;
  onChange: (name: string, value: string) => void;
}) {
  return (
    <>
      {Object.entries(fields).flatMap(([name, descriptor]) => {
        if (descriptor.automated) return [];
        if (
          descriptor.visibleWhen &&
          values[descriptor.visibleWhen.field] !== descriptor.visibleWhen.equals
        )
          return [];
        const inputId = `connector-field-${name}`;
        return [
          <div key={name} className="space-y-2">
            <Label htmlFor={inputId}>
              {descriptor.title}
              {descriptor.optional ? " (optional)" : ""}
            </Label>
            {descriptor.enum ? (
              <Select value={values[name] ?? ""} onValueChange={(value) => onChange(name, value)}>
                <SelectTrigger id={inputId} className="w-full">
                  <SelectValue placeholder={`Choose ${descriptor.title.toLowerCase()}`} />
                </SelectTrigger>
                <SelectContent>
                  {descriptor.enum.map((value) => (
                    <SelectItem key={value} value={value}>
                      {value}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : (
              <div className="flex items-center rounded-md border bg-background focus-within:ring-2 focus-within:ring-ring/50">
                {descriptor.prefix ? (
                  <span className="pl-3 text-meta text-muted-foreground">{descriptor.prefix}</span>
                ) : null}
                <Input
                  id={inputId}
                  type={descriptor.secret ? "password" : "text"}
                  value={values[name] ?? ""}
                  placeholder={descriptor.example}
                  pattern={descriptor.pattern}
                  required={!descriptor.optional}
                  autoComplete={descriptor.secret ? "new-password" : undefined}
                  className="border-0 shadow-none focus-visible:ring-0"
                  onChange={(event) => onChange(name, event.target.value)}
                />
                {descriptor.suffix ? (
                  <span className="pr-3 text-meta text-muted-foreground">{descriptor.suffix}</span>
                ) : null}
              </div>
            )}
            {descriptor.description ? (
              <p className="text-meta text-muted-foreground">{descriptor.description}</p>
            ) : null}
          </div>,
        ];
      })}
    </>
  );
}

function ConnectorSettingsSection({
  installation,
  provider,
  scope,
  registrations,
  callbackUrl,
}: {
  installation: ConnectorInstallation;
  provider: CatalogProvider;
  scope: Scope | undefined;
  registrations: Registration[];
  callbackUrl: string;
}) {
  const navigate = useNavigate();
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const isOAuth = ["oauth2_code", "mcp_oauth"].includes(provider.authMode);
  const resolvedRegistration =
    registrations.find((registration) => registration.source === "customer") ??
    registrations.find((registration) => registration.source === "dynamic") ??
    registrations.find((registration) => registration.source === "platform");
  const archive = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.archive({
        installationItemId: installation.id,
      }),
    onSuccess: () => {
      toast.success("Connector uninstalled");
      navigate("/settings/connectors");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  const configItems = Object.entries(installation.config);

  return (
    <SettingsSection
      title="Settings"
      description="Review installation configuration and registration resolution."
    >
      <SettingRow
        label="Installation"
        orientation="stack"
        control={
          <KeyValueList
            items={[
              { label: "Catalog key", value: installation.catalogKey, mono: true },
              {
                label: "Scope",
                value: (
                  <ScopeBadge scope={scope ? scopeDisplayName(scope) : installation.scopeId} />
                ),
              },
              {
                label: "Registration",
                value: resolvedRegistration
                  ? `${resolvedRegistration.source} app`
                  : ["oauth2_code", "mcp_oauth"].includes(provider.authMode)
                    ? "Setup required"
                    : "Not required",
              },
              ...configItems.map(([key, value]) => ({
                label: key,
                value: String(value),
                mono: true,
              })),
            ]}
          />
        }
      />
      {isOAuth ? (
        <SettingRow
          label="OAuth app"
          description="The app at the provider that mints tokens for this connector."
          control={
            <Button variant="outline" onClick={() => setRegistrationOpen(true)}>
              <Settings2 />
              Manage
            </Button>
          }
        />
      ) : null}
      <SettingRow
        label="Uninstall connector"
        description="Archive this installation and revoke all of its credentials."
        control={
          <Button variant="destructive" onClick={() => setConfirmOpen(true)}>
            <Unplug />
            Uninstall
          </Button>
        }
      />
      <RegistrationDialog
        provider={provider}
        registrations={registrations}
        callbackUrl={callbackUrl}
        open={registrationOpen}
        onOpenChange={setRegistrationOpen}
      />
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {provider.displayName}?</AlertDialogTitle>
            <AlertDialogDescription>
              This archives the installation and revokes its credentials. Agents will lose access to
              its tools in {scope ? scopeDisplayName(scope) : "this scope"}.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={archive.isPending}
              onClick={() => archive.mutate()}
            >
              {archive.isPending ? "Uninstalling…" : "Uninstall connector"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
