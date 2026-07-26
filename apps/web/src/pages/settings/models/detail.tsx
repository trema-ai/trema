import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import { Input } from "#web/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { ProviderLogo } from "#web/pages/settings/models/provider-logo.tsx";
import {
  type CatalogRefresh,
  credentialModeLabel,
  descriptorOf,
  type ModelProtocol,
  type ModelProvider,
  messageFrom,
  type ProbeResult,
  protocolLabel,
} from "#web/pages/settings/models/shared.tsx";

export function SettingsModelProviderPage() {
  const { providerName = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(
    orpc.modelProviders.providers.get.queryOptions({ input: { name: providerName } }),
  );
  const provider = query.data as ModelProvider | undefined;

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.providers.get.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.providers.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.defaults.list.key() }),
    ]);
  }

  if (query.isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6 lg:p-8">
        <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
        {[1, 2, 3].map((key) => (
          <div key={key} className="h-40 animate-pulse rounded-lg border bg-muted/30" />
        ))}
      </main>
    );
  }
  if (query.error) {
    return (
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
        <Alert variant="destructive">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      </main>
    );
  }
  if (!provider) {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={Boxes}
          title="Provider not found"
          description="No provider by this name is in the registry."
          action={<Button onClick={() => navigate("/settings/models")}>Back to models</Button>}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        leading={
          <ProviderLogo
            name={provider.name}
            label={provider.label}
            baseUrl={provider.baseUrl}
            className="size-10"
          />
        }
        title={provider.label}
        description={
          <>
            {provider.name} · {protocolLabel(provider.protocol)} · updated{" "}
            <RelativeTime date={provider.updatedAt} />
          </>
        }
      />
      <div className="space-y-7">
        <EndpointSection provider={provider} onChanged={invalidate} />
        <CredentialSection provider={provider} onChanged={invalidate} />
        <HeadersSection provider={provider} onChanged={invalidate} />
        <ModelsSection provider={provider} onChanged={invalidate} />
        <DangerZone
          provider={provider}
          onDeleted={async () => {
            await invalidate();
            navigate("/settings/models");
          }}
        />
      </div>
    </main>
  );
}

function EndpointSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [protocol, setProtocol] = useState<ModelProtocol>(provider.protocol);
  useEffect(() => {
    setLabel(provider.label);
    setBaseUrl(provider.baseUrl);
    setProtocol(provider.protocol);
  }, [provider.label, provider.baseUrl, provider.protocol]);
  const dirty =
    label !== provider.label || baseUrl !== provider.baseUrl || protocol !== provider.protocol;
  const save = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        label: label.trim() || provider.name,
        baseUrl: baseUrl.trim(),
        protocol,
      }),
    onSuccess: async () => {
      await onChanged();
      toast.success("Endpoint saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit}>
      <SettingsSection title="Endpoint">
        <SettingRow
          label="Display name"
          orientation="stack"
          control={
            <Input
              aria-label="Display name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          }
        />
        <SettingRow
          label="Base URL"
          description="Include the version path, the way the provider documents it."
          orientation="stack"
          control={
            <Input
              aria-label="Base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          }
        />
        <SettingRow
          label="Protocol"
          control={
            <Select value={protocol} onValueChange={(value) => setProtocol(value as ModelProtocol)}>
              <SelectTrigger aria-label="Protocol" className="w-56">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="openai_compatible">
                  {protocolLabel("openai_compatible")}
                </SelectItem>
              </SelectContent>
            </Select>
          }
        />
        <SettingRow
          label=""
          control={
            <Button disabled={!dirty || save.isPending}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          }
        />
      </SettingsSection>
    </form>
  );
}

function CredentialSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [result, setResult] = useState<ProbeResult>();

  // Both writes carry the mode with the value: a provider in key mode with no
  // key is a state the registry refuses, so the screen never proposes it.
  const store = useMutation({
    mutationFn: (value: string) =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "api_key",
        credential: value,
      }),
    onSuccess: async () => {
      await onChanged();
      setCredential("");
      toast.success("Key saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const drop = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "none",
        credential: null,
      }),
    onSuccess: async () => {
      await onChanged();
      setConfirmRemove(false);
      toast.success("Credential removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const probe = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.probe({ name: provider.name }),
    onSuccess: (probed) => setResult(probed),
    onError: (error) => toast.error(messageFrom(error)),
  });

  const keyed = provider.credentialMode === "api_key";
  return (
    <SettingsSection title="Credential">
      <SettingRow
        label="Authentication"
        description={
          keyed
            ? "Requests carry a bearer key."
            : "Requests go unauthenticated suitable for an endpoint on a trusted network."
        }
        control={
          <div className="flex items-center gap-3">
            {/* A provider in key mode always has one stored: the registry refuses the other state. */}
            <CredentialStatusBadge
              status="connected"
              label={keyed ? "Key stored" : credentialModeLabel("none")}
            />
            {keyed ? (
              <Button variant="outline" onClick={() => setConfirmRemove(true)}>
                Remove credential
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingRow
        label={keyed ? "Replace the API key" : "Switch to an API key"}
        description={
          keyed
            ? "A stored key is never read back, only replaced."
            : "Entering a key turns on bearer authentication for every request."
        }
        orientation="stack"
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="password"
              aria-label="API key"
              autoComplete="new-password"
              className="max-w-sm"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <Button
              disabled={credential.trim().length === 0 || store.isPending}
              onClick={() => store.mutate(credential.trim())}
            >
              {store.isPending ? "Saving…" : "Save key"}
            </Button>
          </div>
        }
      />
      <SettingRow
        label="Health check"
        description={
          result
            ? result.ok
              ? `Answered in ${result.latencyMs} ms${
                  result.modelCount === undefined ? "" : `, listing ${result.modelCount} models`
                }.`
              : result.reason
            : ""
        }
        control={
          <Button variant="outline" disabled={probe.isPending} onClick={() => probe.mutate()}>
            {probe.isPending ? "Checking…" : "Check now"}
          </Button>
        }
      />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the stored credential?</AlertDialogTitle>
            <AlertDialogDescription>
              The key is discarded and requests to this provider go unauthenticated. Most providers
              answer that with a 401 until a new key is entered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={drop.isPending}
              onClick={() => drop.mutate()}
            >
              {drop.isPending ? "Removing…" : "Remove credential"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function HeadersSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <SettingsSection title="Extra headers">
      <SettingRow
        label={
          provider.headerNames.length === 0 ? "No extra headers" : provider.headerNames.join(", ")
        }
        description={
          provider.headerNames.length === 0
            ? ""
            : "Replacing the set means entering every value again, since the stored ones cannot be read."
        }
        control={
          <Button variant="outline" onClick={() => setEditing(true)}>
            {provider.headerNames.length === 0 ? "Add headers" : "Replace headers"}
          </Button>
        }
      />
      <HeadersDialog
        provider={provider}
        open={editing}
        onOpenChange={setEditing}
        onChanged={onChanged}
      />
    </SettingsSection>
  );
}

function HeadersDialog({
  provider,
  open,
  onOpenChange,
  onChanged,
}: {
  provider: ModelProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<{ key: string; name: string; value: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    setRows(
      (provider.headerNames.length === 0 ? [""] : provider.headerNames).map((name) => ({
        key: crypto.randomUUID(),
        name,
        value: "",
      })),
    );
  }, [open, provider.headerNames]);

  const named = rows.filter((row) => row.name.trim().length > 0);
  // Stored values cannot be pre-filled, so a row saved blank would quietly
  // replace a working header with an empty one. Trimmed, because the server
  // trims before storing — spaces-only is blank.
  const missingValue = named.some((row) => row.value.trim().length === 0);
  // Header names are case-insensitive, and the map a save builds keeps the last
  // row of a repeated name — so two rows for one header would silently drop
  // half of what was typed.
  const fields = named.map((row) => row.name.trim().toLowerCase());
  const duplicateName = fields.find((field, index) => fields.indexOf(field) !== index);

  const save = useMutation({
    mutationFn: () => {
      const headers = Object.fromEntries(named.map((row) => [row.name.trim(), row.value]));
      return rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        headers: named.length === 0 ? null : headers,
      });
    },
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success("Headers saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Extra headers</DialogTitle>
          <DialogDescription>
            This replaces the whole set. Every header needs its value typed again, because a stored
            value is never read back. A row left without a name is dropped, and saving with no rows
            removes every header.
          </DialogDescription>
        </DialogHeader>
        <div className="my-4 space-y-2">
          {rows.map((row, index) => (
            <div key={row.key} className="flex items-center gap-2">
              <Input
                aria-label={`Header ${index + 1} name`}
                placeholder="x-tenant"
                value={row.name}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, position) =>
                      position === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Input
                aria-label={`Header ${index + 1} value`}
                type="password"
                autoComplete="off"
                placeholder="value"
                value={row.value}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, position) =>
                      position === index ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove header ${index + 1}`}
                onClick={() =>
                  setRows((current) => current.filter((_, position) => position !== index))
                }
              >
                <X />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              setRows((current) => [...current, { key: crypto.randomUUID(), name: "", value: "" }])
            }
          >
            <Plus />
            Add header
          </Button>
          {missingValue ? (
            <p className="text-meta text-destructive">
              Enter a value for every header, or remove the row.
            </p>
          ) : null}
          {duplicateName ? (
            <p className="text-meta text-destructive">
              Two rows name the {duplicateName} header. Header names are case-insensitive, so keep
              one of them.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={missingValue || duplicateName !== undefined || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save headers"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelsSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [result, setResult] = useState<CatalogRefresh>();
  // On demand only: providers rate-limit, so nothing reads a model list in the
  // background or on a page view.
  const refresh = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.refreshCatalog({ name: provider.name }),
    onSuccess: async (refreshed) => {
      setResult(refreshed as CatalogRefresh);
      await onChanged();
      if (refreshed.ok) toast.success("Model list read");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const count = provider.catalog.length;

  return (
    <SettingsSection
      title="Models"
      description="Models served by this provider, as of the last refresh."
    >
      <SettingRow
        label={`${count} model${count === 1 ? "" : "s"}`}
        description={
          result === undefined
            ? ""
            : result.ok
              ? `Answered in ${result.latencyMs} ms. ${result.added} added, ${result.removed} dropped.`
              : result.reason
        }
        control={
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />
              {refresh.isPending ? "Reading…" : "Refresh models"}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}

function DangerZone({
  provider,
  onDeleted,
}: {
  provider: ModelProvider;
  onDeleted: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.delete({ name: provider.name }),
    onSuccess: async () => {
      toast.success(`${provider.label} removed`);
      await onDeleted();
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <SettingsSection
      title="Danger zone"
      description="Removing a provider takes its stored credential with it."
    >
      <SettingRow
        label={`Remove ${provider.label}`}
        control={
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2 />
            Remove
          </Button>
        }
      />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {provider.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any role whose first entry names it falls through to the next one, and a role left
              with nothing degrades: turns cannot run, embeddings fall back to lexical search.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Removing…" : "Remove provider"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
