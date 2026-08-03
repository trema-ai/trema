import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link2,
  MessageSquareText,
  Plus,
  RefreshCw,
  Settings2,
  Trash2,
  UserRoundCheck,
} from "lucide-react";
import { type FormEvent, useCallback, useEffect, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { CopyButton } from "#web/components/trema/copy-button.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
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
import { Badge } from "#web/components/ui/badge.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { scopeDisplayName } from "#web/lib/scopes.ts";
import { RegistrationDialog } from "#web/pages/settings/connectors/registration-dialog.tsx";
import {
  type CatalogProvider,
  messageFrom,
  type Registration,
  type Scope,
} from "#web/pages/settings/connectors/shared.tsx";

type SlackInstallation = {
  id: string;
  label: string | null;
  workspaceId: string | null;
  workspaceName: string | null;
  enterpriseId: string | null;
  enterpriseName: string | null;
  botUserId: string | null;
  appId: string | null;
  installerUserId: string | null;
  providerScopes: string[];
  isValid: boolean;
  isRevoked: boolean;
  isExpired: boolean;
  isCredentialUnavailable: boolean;
  refreshExhausted: boolean;
  createdAt: string;
  updatedAt: string;
  revokedAt: string | null;
  installations: Array<{ id: string; scopeId: string }>;
};

type SlackBinding = {
  id: string;
  workspaceId: string;
  channelId: string;
  scopeId: string;
  scopeName: string;
  scopeKind: "org" | "shared";
  createdAt: string;
};

type SlackIdentity = {
  id: string;
  workspaceId: string;
  userId: string;
  principalId: string;
  principalName: string;
};

type Member = {
  principal: { id: string; displayName: string };
  status: "active" | "deactivated";
};

function returnUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("connected");
  url.searchParams.delete("connector_error");
  url.searchParams.delete("connector_status");
  return url.toString();
}

function installationLabel(installation: SlackInstallation) {
  return installation.workspaceName ?? installation.label ?? installation.workspaceId ?? "Slack";
}

function statusFor(installation: SlackInstallation) {
  if (installation.isValid) return { label: "Connected", variant: "default" as const };
  if (installation.isRevoked) return { label: "Uninstalled", variant: "secondary" as const };
  if (installation.refreshExhausted) {
    return { label: "Refresh failed", variant: "destructive" as const };
  }
  if (installation.isExpired) return { label: "Expired", variant: "destructive" as const };
  if (installation.isCredentialUnavailable) {
    return { label: "Credential unavailable", variant: "destructive" as const };
  }
  return { label: "Needs attention", variant: "outline" as const };
}

const slackId = /^[A-Z][A-Z0-9]{1,31}$/;

export function slackBindingRequest(searchParams: URLSearchParams) {
  if (searchParams.get("setup") !== "slack-channel") return undefined;
  const workspaceId = searchParams.get("workspaceId")?.trim().toUpperCase();
  const channelId = searchParams.get("channelId")?.trim().toUpperCase();
  if (!workspaceId || !channelId || !slackId.test(workspaceId) || !slackId.test(channelId)) {
    return undefined;
  }
  return { workspaceId, channelId };
}

export function SettingsMessagingPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const registrations = useQuery(orpc.connectors.registrations.list.queryOptions({}));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const installations = useQuery(orpc.messaging.slack.installations.list.queryOptions({}));
  const bindings = useQuery(orpc.messaging.slack.bindings.list.queryOptions({}));
  const identities = useQuery(orpc.messaging.slack.identities.list.queryOptions({}));
  const members = useQuery(orpc.members.list.queryOptions({}));
  const manifest = useQuery(orpc.messaging.slack.manifest.queryOptions({}));
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const [installOpen, setInstallOpen] = useState(false);
  const [reauthorize, setReauthorize] = useState<SlackInstallation>();
  const bindingRequest = slackBindingRequest(searchParams);

  const provider = ((catalog.data ?? []) as CatalogProvider[]).find(({ key }) => key === "slack");
  const registrationRows = ((registrations.data ?? []) as Registration[]).filter(
    ({ providerKey }) => providerKey === "slack",
  );
  const usableRegistration = registrationRows.some(({ isUsable }) => isUsable);
  const scopeRows = ((scopes.data ?? []) as Scope[]).filter(
    ({ kind }) => kind === "org" || kind === "shared",
  );
  const installationRows = (installations.data ?? []) as SlackInstallation[];
  const activeInstallations = installationRows.filter(({ isRevoked }) => !isRevoked);
  const bindingRows = (bindings.data ?? []) as SlackBinding[];
  const identityRows = (identities.data ?? []) as SlackIdentity[];
  const memberRows = ((members.data ?? []) as Member[]).filter(({ status }) => status === "active");
  const error =
    catalog.error ??
    registrations.error ??
    scopes.error ??
    installations.error ??
    bindings.error ??
    identities.error ??
    members.error ??
    manifest.error;

  const invalidate = useCallback(async () => {
    await Promise.all([
      queryClient.invalidateQueries({
        queryKey: orpc.messaging.slack.installations.list.key(),
      }),
      queryClient.invalidateQueries({ queryKey: orpc.messaging.slack.bindings.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.messaging.slack.identities.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.connectors.connections.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.connectors.installations.list.key() }),
    ]);
  }, [queryClient]);

  const clearBindingRequest = useCallback(() => {
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("setup");
        next.delete("workspaceId");
        next.delete("channelId");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  useEffect(() => {
    const connectorError = searchParams.get("connector_error");
    const connected = searchParams.get("connected");
    if (!connectorError && !connected) return;

    if (connectorError) {
      toast.error(
        connectorError === "account_conflict"
          ? "This Slack workspace is already connected to another Trema organization"
          : connectorError === "account_mismatch"
            ? "Reauthorization selected a different Slack workspace"
            : `Slack connection failed: ${connectorError.replaceAll("_", " ")}`,
      );
    }
    if (connected) {
      toast.success("Slack workspace connected");
      void invalidate();
    }
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.delete("connected");
        next.delete("connector_error");
        next.delete("connector_status");
        return next;
      },
      { replace: true },
    );
  }, [invalidate, searchParams, setSearchParams]);

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Messaging"
        description="Install messaging surfaces and choose the conversations and people Trema can serve."
        actions={
          provider ? (
            <Button
              onClick={() => {
                if (!usableRegistration) setRegistrationOpen(true);
                else setInstallOpen(true);
              }}
            >
              <Plus />
              Install Slack
            </Button>
          ) : null
        }
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-8">
        <section data-slot="settings-section">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-chrome font-medium">Slack workspaces</h2>
              <p className="mt-0.5 text-meta text-muted-foreground">
                Trema uses an organization-agent credential for every shared conversation.
              </p>
            </div>
            <Button
              variant="outline"
              onClick={() => setRegistrationOpen(true)}
              disabled={!provider}
            >
              <Settings2 />
              Configure Slack app
            </Button>
          </div>
          <div className="mt-3 space-y-3">
            {installations.isPending ? (
              <div className="h-28 animate-pulse rounded-md border bg-muted/40" />
            ) : installationRows.length === 0 ? (
              <div className="rounded-md border bg-card">
                <EmptyState
                  icon={MessageSquareText}
                  title="Slack is not installed"
                  description="Configure the Slack app, then authorize the first workspace."
                />
              </div>
            ) : (
              installationRows.map((installation) => (
                <InstallationRow
                  key={installation.id}
                  installation={installation}
                  scopes={scopeRows}
                  onReauthorize={() => setReauthorize(installation)}
                  onChanged={invalidate}
                />
              ))
            )}
          </div>
        </section>

        <BindingsSection
          installations={activeInstallations}
          scopes={scopeRows}
          bindings={bindingRows}
          requestedWorkspaceId={bindingRequest?.workspaceId}
          requestedChannelId={bindingRequest?.channelId}
          onRequestHandled={clearBindingRequest}
          onChanged={invalidate}
        />
        <IdentitiesSection
          installations={activeInstallations}
          members={memberRows}
          identities={identityRows}
          onChanged={invalidate}
        />
        {manifest.data ? (
          <ManifestSection
            manifest={manifest.data.manifest}
            callbackUrl={manifest.data.callbackUrl}
            eventsUrl={manifest.data.eventsUrl}
            interactionsUrl={manifest.data.interactionsUrl}
          />
        ) : null}
      </div>

      {provider ? (
        <RegistrationDialog
          provider={provider}
          registrations={registrationRows}
          callbackUrl={manifest.data?.callbackUrl ?? ""}
          open={registrationOpen}
          onOpenChange={setRegistrationOpen}
          onSaved={() => {
            setRegistrationOpen(false);
            setInstallOpen(true);
          }}
        />
      ) : null}
      <InstallDialog
        installation={reauthorize}
        scopes={scopeRows}
        open={installOpen || reauthorize !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setInstallOpen(false);
            setReauthorize(undefined);
          }
        }}
      />
    </main>
  );
}

function InstallationRow({
  installation,
  scopes,
  onReauthorize,
  onChanged,
}: {
  installation: SlackInstallation;
  scopes: Scope[];
  onReauthorize: () => void;
  onChanged: () => Promise<void>;
}) {
  const [confirmUninstall, setConfirmUninstall] = useState(false);
  const uninstall = useMutation({
    mutationFn: () =>
      rpcClient.messaging.slack.installations.uninstall({ installationId: installation.id }),
    onSuccess: async () => {
      await onChanged();
      setConfirmUninstall(false);
      toast.success("Slack uninstalled");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const status = statusFor(installation);
  const scopeNames = installation.installations
    .map(({ scopeId }) => scopes.find(({ id }) => id === scopeId))
    .filter((scope): scope is Scope => scope !== undefined)
    .map(scopeDisplayName);
  return (
    <div className="rounded-md border bg-card px-4 py-3.5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 gap-3">
          <img
            src="/connector-logos/slack.svg"
            alt=""
            className="size-10 shrink-0 rounded-md border bg-white p-2"
          />
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h3 className="font-medium">{installationLabel(installation)}</h3>
              <Badge variant={status.variant}>{status.label}</Badge>
            </div>
            <p className="mt-1 text-meta text-muted-foreground">
              {installation.workspaceId ?? "Workspace ID unavailable"}
              {installation.enterpriseName ? ` · ${installation.enterpriseName}` : ""}
              {installation.botUserId ? ` · bot ${installation.botUserId}` : ""}
            </p>
            <p className="mt-1 text-meta text-muted-foreground">
              {scopeNames.length > 0 ? `Default reach: ${scopeNames.join(", ")}` : "No scope reach"}
              {" · Installed "}
              <RelativeTime date={installation.createdAt} />
            </p>
          </div>
        </div>
        <div className="flex gap-2">
          <Button size="sm" variant="outline" onClick={onReauthorize}>
            <RefreshCw />
            Reauthorize
          </Button>
          {!installation.isRevoked ? (
            <Button size="sm" variant="destructive" onClick={() => setConfirmUninstall(true)}>
              <Trash2 />
              Uninstall
            </Button>
          ) : null}
        </div>
      </div>
      <AlertDialog open={confirmUninstall} onOpenChange={setConfirmUninstall}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Uninstall {installationLabel(installation)}?</AlertDialogTitle>
            <AlertDialogDescription>
              Trema will revoke the Slack authorization. Existing bindings remain visible but stop
              resolving until this workspace is authorized again.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={uninstall.isPending}
              onClick={() => uninstall.mutate()}
            >
              {uninstall.isPending ? "Uninstalling…" : "Uninstall"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function InstallDialog({
  installation,
  scopes,
  open,
  onOpenChange,
}: {
  installation?: SlackInstallation | undefined;
  scopes: Scope[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const initialScopeId =
    installation?.installations[0]?.scopeId ??
    scopes.find(({ kind }) => kind === "org")?.id ??
    scopes[0]?.id ??
    "";
  const [scopeId, setScopeId] = useState(initialScopeId);
  useEffect(() => {
    if (open) setScopeId(initialScopeId);
  }, [open, initialScopeId]);
  const start = useMutation({
    mutationFn: () =>
      rpcClient.messaging.slack.installations.start({
        defaultScopeId: scopeId,
        ...(installation ? { installationId: installation.id } : {}),
        returnTo: returnUrl(),
      }),
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{installation ? "Reauthorize" : "Install"} Slack</DialogTitle>
          <DialogDescription>
            Slack redirects back to Trema after an admin authorizes the workspace. The credential is
            encrypted and owned by the organization agent.
          </DialogDescription>
        </DialogHeader>
        <div className="my-4 space-y-2">
          <Label htmlFor="slack-default-scope">Default scope</Label>
          <Select value={scopeId} onValueChange={setScopeId} disabled={installation !== undefined}>
            <SelectTrigger id="slack-default-scope" className="w-full">
              <SelectValue placeholder="Choose a scope" />
            </SelectTrigger>
            <SelectContent>
              {scopes.map((scope) => (
                <SelectItem key={scope.id} value={scope.id}>
                  {scopeDisplayName(scope)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-meta text-muted-foreground">
            {installation
              ? "Reauthorization preserves the installation's current scope reach."
              : "Allowed conversations may target this scope or a narrower shared scope."}
          </p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!scopeId || start.isPending} onClick={() => start.mutate()}>
            {start.isPending ? "Redirecting…" : "Continue to Slack"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function BindingsSection({
  installations,
  scopes,
  bindings,
  requestedWorkspaceId,
  requestedChannelId,
  onRequestHandled,
  onChanged,
}: {
  installations: SlackInstallation[];
  scopes: Scope[];
  bindings: SlackBinding[];
  requestedWorkspaceId: string | undefined;
  requestedChannelId: string | undefined;
  onRequestHandled: () => void;
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [scopeId, setScopeId] = useState(
    scopes.find(({ kind }) => kind === "org")?.id ?? scopes[0]?.id ?? "",
  );
  const [channelId, setChannelId] = useState("");
  const selected = installations.find(({ id }) => id === installationId);
  useEffect(() => {
    if (!installations.some(({ id }) => id === installationId)) {
      setInstallationId(installations[0]?.id ?? "");
    }
  }, [installations, installationId]);
  useEffect(() => {
    if (!requestedWorkspaceId || !requestedChannelId) return;
    const requestedInstallation = installations.find(
      ({ workspaceId }) => workspaceId === requestedWorkspaceId,
    );
    if (requestedInstallation === undefined) return;
    setInstallationId(requestedInstallation.id);
    setChannelId(requestedChannelId);
    setAdding(true);
    onRequestHandled();
  }, [installations, onRequestHandled, requestedChannelId, requestedWorkspaceId]);
  const create = useMutation({
    mutationFn: () =>
      rpcClient.messaging.slack.bindings.create({
        installationId,
        workspaceId: selected?.workspaceId ?? "",
        channelId,
        scopeId,
      }),
    onSuccess: async () => {
      await onChanged();
      setChannelId("");
      setAdding(false);
      toast.success("Slack conversation allowed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const remove = useMutation({
    mutationFn: (bindingId: string) => rpcClient.messaging.slack.bindings.remove({ bindingId }),
    onSuccess: async () => {
      await onChanged();
      toast.success("Slack conversation removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    create.mutate();
  }

  return (
    <section data-slot="settings-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-chrome font-medium">Allowed conversations</h2>
          <p className="mt-0.5 text-meta text-muted-foreground">
            An unlisted shared channel is rejected without falling back to another scope.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setAdding(true)}
          disabled={installations.length === 0 || scopes.length === 0}
        >
          <Link2 />
          Allow conversation
        </Button>
      </div>
      <div className="mt-3 divide-y rounded-md border bg-card">
        {bindings.length === 0 ? (
          <EmptyState
            icon={Link2}
            title="No allowed conversations"
            description="Add a Slack channel or DM conversation ID before Trema accepts messages there."
          />
        ) : (
          bindings.map((binding) => (
            <div key={binding.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-mono text-sm">{binding.channelId}</p>
                <p className="mt-0.5 text-meta text-muted-foreground">
                  {binding.workspaceId} · {binding.scopeName}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Remove ${binding.channelId}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(binding.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Allow a Slack conversation</DialogTitle>
              <DialogDescription>
                Copy the channel or direct-message conversation ID from Slack. Threads inherit the
                channel's scope.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="binding-workspace">Workspace</Label>
                <Select value={installationId} onValueChange={setInstallationId}>
                  <SelectTrigger id="binding-workspace" className="w-full">
                    <SelectValue placeholder="Choose a workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {installations.map((installation) => (
                      <SelectItem key={installation.id} value={installation.id}>
                        {installationLabel(installation)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="binding-channel">Conversation ID</Label>
                <Input
                  id="binding-channel"
                  value={channelId}
                  onChange={(event) => setChannelId(event.target.value.toUpperCase())}
                  placeholder="C0123456789"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="binding-scope">Scope</Label>
                <Select value={scopeId} onValueChange={setScopeId}>
                  <SelectTrigger id="binding-scope" className="w-full">
                    <SelectValue placeholder="Choose a scope" />
                  </SelectTrigger>
                  <SelectContent>
                    {scopes.map((scope) => (
                      <SelectItem key={scope.id} value={scope.id}>
                        {scopeDisplayName(scope)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button
                disabled={create.isPending || !installationId || !selected?.workspaceId || !scopeId}
              >
                {create.isPending ? "Allowing…" : "Allow conversation"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function IdentitiesSection({
  installations,
  members,
  identities,
  onChanged,
}: {
  installations: SlackInstallation[];
  members: Member[];
  identities: SlackIdentity[];
  onChanged: () => Promise<void>;
}) {
  const [adding, setAdding] = useState(false);
  const [installationId, setInstallationId] = useState(installations[0]?.id ?? "");
  const [principalId, setPrincipalId] = useState(members[0]?.principal.id ?? "");
  const [userId, setUserId] = useState("");
  const selected = installations.find(({ id }) => id === installationId);
  useEffect(() => {
    if (!installations.some(({ id }) => id === installationId)) {
      setInstallationId(installations[0]?.id ?? "");
    }
  }, [installations, installationId]);
  useEffect(() => {
    if (!members.some(({ principal }) => principal.id === principalId)) {
      setPrincipalId(members[0]?.principal.id ?? "");
    }
  }, [members, principalId]);
  const set = useMutation({
    mutationFn: () =>
      rpcClient.messaging.slack.identities.set({
        workspaceId: selected?.workspaceId ?? "",
        userId,
        principalId,
      }),
    onSuccess: async () => {
      await onChanged();
      setUserId("");
      setAdding(false);
      toast.success("Slack user linked");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const remove = useMutation({
    mutationFn: (identityLinkId: string) =>
      rpcClient.messaging.slack.identities.remove({ identityLinkId }),
    onSuccess: async () => {
      await onChanged();
      toast.success("Slack user unlinked");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    set.mutate();
  }
  return (
    <section data-slot="settings-section">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h2 className="text-chrome font-medium">Requester identities</h2>
          <p className="mt-0.5 text-meta text-muted-foreground">
            Slack user IDs are workspace-scoped and must map to an active Trema member.
          </p>
        </div>
        <Button
          variant="outline"
          onClick={() => setAdding(true)}
          disabled={installations.length === 0 || members.length === 0}
        >
          <UserRoundCheck />
          Link user
        </Button>
      </div>
      <div className="mt-3 divide-y rounded-md border bg-card">
        {identities.length === 0 ? (
          <EmptyState
            icon={UserRoundCheck}
            title="No linked Slack users"
            description="Unlinked Slack users cannot start executable Trema work."
          />
        ) : (
          identities.map((identity) => (
            <div key={identity.id} className="flex items-center justify-between gap-3 px-4 py-3">
              <div>
                <p className="font-medium">{identity.principalName}</p>
                <p className="mt-0.5 font-mono text-meta text-muted-foreground">
                  {identity.workspaceId}:{identity.userId}
                </p>
              </div>
              <Button
                size="sm"
                variant="ghost"
                aria-label={`Unlink ${identity.userId}`}
                disabled={remove.isPending}
                onClick={() => remove.mutate(identity.id)}
              >
                <Trash2 />
              </Button>
            </div>
          ))
        )}
      </div>
      <Dialog open={adding} onOpenChange={setAdding}>
        <DialogContent>
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>Link a Slack user</DialogTitle>
              <DialogDescription>
                Copy the member ID from Slack and select the Trema member it represents.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div className="space-y-2">
                <Label htmlFor="identity-workspace">Workspace</Label>
                <Select value={installationId} onValueChange={setInstallationId}>
                  <SelectTrigger id="identity-workspace" className="w-full">
                    <SelectValue placeholder="Choose a workspace" />
                  </SelectTrigger>
                  <SelectContent>
                    {installations.map((installation) => (
                      <SelectItem key={installation.id} value={installation.id}>
                        {installationLabel(installation)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label htmlFor="identity-user">Slack user ID</Label>
                <Input
                  id="identity-user"
                  value={userId}
                  onChange={(event) => setUserId(event.target.value.toUpperCase())}
                  placeholder="U0123456789"
                  required
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="identity-member">Trema member</Label>
                <Select value={principalId} onValueChange={setPrincipalId}>
                  <SelectTrigger id="identity-member" className="w-full">
                    <SelectValue placeholder="Choose a member" />
                  </SelectTrigger>
                  <SelectContent>
                    {members.map(({ principal }) => (
                      <SelectItem key={principal.id} value={principal.id}>
                        {principal.displayName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <DialogFooter>
              <Button type="button" variant="outline" onClick={() => setAdding(false)}>
                Cancel
              </Button>
              <Button disabled={set.isPending || !selected?.workspaceId || !userId || !principalId}>
                {set.isPending ? "Linking…" : "Link user"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </section>
  );
}

function ManifestSection({
  manifest,
  callbackUrl,
  eventsUrl,
  interactionsUrl,
}: {
  manifest: unknown;
  callbackUrl: string;
  eventsUrl: string;
  interactionsUrl: string;
}) {
  const value = JSON.stringify(manifest, null, 2);
  return (
    <section data-slot="settings-section">
      <div>
        <h2 className="text-chrome font-medium">Slack app configuration</h2>
        <p className="mt-0.5 text-meta text-muted-foreground">
          Use this generated manifest when creating the Slack app for this deployment.
        </p>
      </div>
      <div className="mt-3 space-y-3 rounded-md border bg-card p-4">
        {(
          [
            ["OAuth callback", callbackUrl],
            ["Events API", eventsUrl],
            ["Interactivity", interactionsUrl],
          ] satisfies Array<[string, string]>
        ).map(([label, url]) => (
          <div
            key={label}
            className="grid gap-1 sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center"
          >
            <span className="text-meta text-muted-foreground">{label}</span>
            <code className="truncate text-sm">{url}</code>
            <CopyButton value={url} />
          </div>
        ))}
        <details className="border-t pt-3">
          <summary className="cursor-pointer text-chrome font-medium">App manifest JSON</summary>
          <div className="relative mt-3">
            <pre className="max-h-80 overflow-auto rounded-md bg-muted p-3 text-xs">{value}</pre>
            <div className="absolute top-2 right-2">
              <CopyButton value={value} />
            </div>
          </div>
        </details>
      </div>
    </section>
  );
}
