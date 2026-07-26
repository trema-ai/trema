import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, RefreshCw, Settings2, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useRef, useState } from "react";
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
import { Checkbox } from "#web/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Switch } from "#web/components/ui/switch.tsx";
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
  type CatalogEntry,
  credentialModeLabel,
  type ModelCredentialMode,
  type ModelProtocol,
  type ModelProvider,
  type ModelRole,
  messageFrom,
  isEmbeddingModel,
  type ProbeResult,
  protocolLabel,
  type RemoteModels,
  roleLabel,
  roleDescriptions,
} from "#web/pages/settings/models/shared.tsx";

/** The descriptor every write repeats, because a put replaces the whole row. */
type Descriptor = {
  name: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  credentialMode: ModelCredentialMode;
};

function descriptorOf(provider: ModelProvider): Descriptor {
  return {
    name: provider.name,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    credentialMode: provider.credentialMode,
  };
}

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
        <CatalogSection provider={provider} onChanged={invalidate} />
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
      <SettingsSection
        title="Endpoint"
        description="Where requests go, and which wire protocol they speak."
      >
        <SettingRow
          label="Display name"
          description="Shown on this screen. The name role assignments use never changes."
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
          description="A vendor is a preset over a protocol, so this is the wire format, not the brand."
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
          label="Apply changes"
          description="The stored credential is untouched by an endpoint edit."
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
    <SettingsSection
      title="Credential"
      description="Stored encrypted on the server. It reaches the provider in a request header, never the model."
    >
      <SettingRow
        label="Authentication"
        description={
          keyed
            ? "Requests carry a bearer key."
            : "Requests go unauthenticated, which suits an endpoint on a trusted network."
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
            : "One authenticated call, run when you ask for it. Nothing polls the provider."
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
    <SettingsSection
      title="Extra headers"
      description="Sent with every request to this provider. Names are shown; values get the credential's treatment and are never returned."
    >
      <SettingRow
        label={
          provider.headerNames.length === 0 ? "No extra headers" : provider.headerNames.join(", ")
        }
        description={
          provider.headerNames.length === 0
            ? "Most providers need none. A gateway may want a tenant or routing header."
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

/**
 * Everything the dialog can offer: what the provider lists, what is already
 * stored, and what an admin typed in by hand.
 */
function offeredIds(
  remote: RemoteModels | undefined,
  catalog: CatalogEntry[],
  added: string[],
): string[] {
  const ids = new Set<string>();
  for (const model of remote?.ok ? remote.models : []) ids.add(model.id);
  for (const entry of catalog) ids.add(entry.id);
  for (const id of added) ids.add(id);
  return [...ids].sort();
}

/** How many stored models the detail screen lists before it offers to show more. */
const catalogPageSize = 20;

function CatalogSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [configure, setConfigure] = useState(false);
  // A catalog runs to hundreds on a gateway, and this list is a summary, not a
  // reading surface: the dialog is where a long one gets searched.
  const [shownModels, setShownModels] = useState(catalogPageSize);
  // Fetched when the screen opens and cached from there. A page view is the
  // admin asking, which is what keeps this inside the on-demand rule; nothing
  // refetches on its own.
  const remote = useQuery({
    ...orpc.modelProviders.providers.remoteModels.queryOptions({
      input: { name: provider.name },
    }),
    staleTime: 5 * 60_000,
    // Nothing reaches the vendor without the admin asking. A focus refetch
    // would spend plan quota on someone tabbing back to the page.
    refetchOnWindowFocus: false,
    retry: false,
  });
  const listing = remote.data as RemoteModels | undefined;
  const unlisted = listing?.ok
    ? listing.models.filter((model) => !provider.catalog.some((entry) => entry.id === model.id))
        .length
    : 0;

  return (
    <SettingsSection
      title="Models"
      description="What role assignments choose from. A model with no role selected is offered for every role."
    >
      {provider.catalog.length === 0 ? (
        <div className="px-4 py-3.5 text-meta text-muted-foreground">
          No models selected yet, so no role can name this provider.
        </div>
      ) : (
        provider.catalog.slice(0, shownModels).map((entry) => (
          <div key={entry.id} className="flex flex-wrap items-center gap-3 px-4 py-3">
            <div className="min-w-0 flex-1">
              <p className="text-chrome">{entry.id}</p>
              {entry.label && entry.label !== entry.id ? (
                <p className="mt-0.5 truncate text-meta text-muted-foreground">{entry.label}</p>
              ) : null}
            </div>
            <p className="text-meta text-muted-foreground">
              {entry.roles === undefined || entry.roles.length === 0
                ? "Every role"
                : entry.roles.map(roleLabel).join(" · ")}
              {entry.contextWindow
                ? ` · ${new Intl.NumberFormat().format(entry.contextWindow)} tokens`
                : ""}
            </p>
          </div>
        ))
      )}
      {provider.catalog.length > shownModels ? (
        <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-2.5">
          <p className="text-meta text-muted-foreground">
            and {provider.catalog.length - shownModels} more
          </p>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setShownModels((current) => current + catalogPageSize)}
          >
            Show more
          </Button>
        </div>
      ) : null}
      <SettingRow
        label="Model list"
        description={
          remote.isFetching
            ? "Reading the provider's model list…"
            : remote.error
              ? messageFrom(remote.error)
              : listing && !listing.ok
                ? listing.reason
                : !listing?.ok
                  ? "The provider's model list has not been read."
                  : unlisted > 0
                    ? `The provider lists ${unlisted} more model${unlisted === 1 ? "" : "s"}.`
                    : "Everything the provider lists is selected."
        }
        control={
          <div className="flex items-center gap-2">
            <Button
              variant="ghost"
              disabled={remote.isFetching}
              onClick={() => void remote.refetch()}
            >
              <RefreshCw className={remote.isFetching ? "animate-spin" : ""} />
              Refresh
            </Button>
            <Button variant="outline" onClick={() => setConfigure(true)}>
              <Settings2 />
              Configure models
            </Button>
          </div>
        }
      />
      <ConfigureModelsDialog
        provider={provider}
        remote={listing}
        fetching={remote.isFetching}
        open={configure}
        onOpenChange={setConfigure}
        onChanged={onChanged}
      />
    </SettingsSection>
  );
}

function ConfigureModelsDialog({
  provider,
  remote,
  fetching,
  open,
  onOpenChange,
  onChanged,
}: {
  provider: ModelProvider;
  remote: RemoteModels | undefined;
  /** The provider's list is still on its way, so what is offered is incomplete. */
  fetching: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [added, setAdded] = useState<string[]>([]);
  const [draftId, setDraftId] = useState("");
  const [search, setSearch] = useState("");
  const [allModels, setAllModels] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const [roles, setRoles] = useState<Record<string, ModelRole[]>>({});
  // What was selected when the All models switch went on. Turning it back off
  // restores that rather than selecting everything, so a deselection survives
  // the round trip.
  const beforeAllModels = useRef<string[] | undefined>(undefined);
  const available = offeredIds(remote, provider.catalog, added);
  const listed = new Set((remote?.ok ? remote.models : []).map((model) => model.id));
  const stored = new Map(provider.catalog.map((entry) => [entry.id, entry]));
  // What the provider said about its own models, where it said anything. Only
  // some listings carry it, so this map is usually empty and the name is all
  // there is to go on.
  const hints = new Map(
    (remote?.ok ? remote.models : []).flatMap((model) =>
      model.embedding === undefined ? [] : [[model.id, model.embedding] as const],
    ),
  );
  const statedEmbedding = hints.size > 0;

  useEffect(() => {
    if (!open) return;
    setAdded([]);
    setDraftId("");
    setSearch("");
    setAllModels(false);
    beforeAllModels.current = undefined;
    setSelected(provider.catalog.map((entry) => entry.id));
    setRoles(
      Object.fromEntries(provider.catalog.map((entry) => [entry.id, entry.roles ?? []])) as Record<
        string,
        ModelRole[]
      >,
    );
  }, [open, provider.catalog]);

  const filtered = available.filter((id) =>
    `${id} ${stored.get(id)?.label ?? ""}`.toLowerCase().includes(search.toLowerCase()),
  );
  // Rows are grouped by what is stored, not by what is being edited, so a row
  // does not jump between sections while its checkboxes are being ticked.
  const isEmbedding = (id: string) => {
    const entry = stored.get(id);
    return entry
      ? entry.roles?.length === 1 && entry.roles[0] === "embed"
      : isEmbeddingModel(id, hints.get(id));
  };
  const chatModels = filtered.filter((id) => !isEmbedding(id));
  const embeddingModels = filtered.filter(isEmbedding);

  /** What a model gets the first time it is enabled. A stored model keeps its own. */
  const defaultRoles = (id: string): ModelRole[] =>
    !stored.has(id) && isEmbeddingModel(id, hints.get(id)) ? ["embed"] : [];

  function toggle(id: string, enabled: boolean) {
    setSelected((current) =>
      enabled ? [...current, id] : current.filter((chosen) => chosen !== id),
    );
    if (enabled) {
      setRoles((current) => (id in current ? current : { ...current, [id]: defaultRoles(id) }));
    }
  }

  function toggleRole(id: string, role: ModelRole, checked: boolean) {
    setRoles((current) => {
      const next = new Set(current[id] ?? defaultRoles(id));
      if (checked) next.add(role);
      else next.delete(role);
      return { ...current, [id]: [...next] };
    });
  }

  const save = useMutation({
    mutationFn: () => {
      const chosen = allModels ? available : available.filter((id) => selected.includes(id));
      // Stored labels and context windows survive: this dialog decides which
      // models are offered and for which roles, not what they are called.
      const catalog: CatalogEntry[] = chosen.map((id) => {
        const entry = stored.get(id);
        const chosenRoles = roles[id] ?? defaultRoles(id);
        return {
          id,
          ...(entry?.label ? { label: entry.label } : {}),
          ...(chosenRoles.length > 0 ? { roles: chosenRoles } : {}),
          ...(entry?.contextWindow ? { contextWindow: entry.contextWindow } : {}),
        };
      });
      return rpcClient.modelProviders.providers.put({ ...descriptorOf(provider), catalog });
    },
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success("Model list saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function addByHand() {
    const id = draftId.trim();
    if (id.length === 0 || available.includes(id)) {
      setDraftId("");
      return;
    }
    setAdded((current) => [...current, id]);
    setSelected((current) => [...current, id]);
    setDraftId("");
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[85vh] grid-rows-[auto_minmax(0,1fr)_auto] overflow-hidden sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>Configure models</DialogTitle>
          <DialogDescription>
            The selected models are what role assignments choose from. The list comes from the
            provider itself, and anything already stored stays visible even when it does not answer.
          </DialogDescription>
        </DialogHeader>
        <div className="min-h-0 space-y-4 overflow-y-auto pr-1">
          <div className="rounded-md border">
            <SettingRow
              label="All models"
              description="Selects every model this provider offers, including any a search is hiding. Models the provider adds later are not picked up until you open this again."
              control={
                <Switch
                  checked={allModels}
                  onCheckedChange={(checked) => {
                    setAllModels(checked);
                    if (checked) {
                      beforeAllModels.current = selected;
                      return;
                    }
                    // Without a remembered selection the switch was already on
                    // when the dialog opened, and everything shown is what the
                    // admin has agreed to.
                    setSelected(beforeAllModels.current ?? available);
                    beforeAllModels.current = undefined;
                  }}
                />
              }
            />
          </div>
          {remote && !remote.ok ? (
            <p className="text-meta text-muted-foreground">
              {remote.reason} Models already stored are listed below, and one can be added by id.
            </p>
          ) : null}
          <Input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Search models"
          />
          {filtered.length === 0 ? (
            <p className="rounded-md border px-3 py-4 text-meta text-muted-foreground">
              No model matches. Add one by id below.
            </p>
          ) : (
            <div className="space-y-4">
              <ModelGroup
                heading="Models"
                ids={chatModels}
                stored={stored}
                listed={listed}
                selected={selected}
                roles={roles}
                allModels={allModels}
                defaultRoles={defaultRoles}
                onToggle={toggle}
                onToggleRole={toggleRole}
              />
              <ModelGroup
                heading="Embedding models"
                note={
                  statedEmbedding
                    ? "Grouped by what this provider says each model produces. Change a role beside a model if it belongs elsewhere."
                    : "Grouped by name, which is all this provider's model list says. Change a role beside a model if the guess is wrong."
                }
                ids={embeddingModels}
                stored={stored}
                listed={listed}
                selected={selected}
                roles={roles}
                allModels={allModels}
                defaultRoles={defaultRoles}
                onToggle={toggle}
                onToggleRole={toggleRole}
              />
            </div>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-64"
              aria-label="Model id"
              placeholder="Add a model by id"
              value={draftId}
              onChange={(event) => setDraftId(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter") return;
                event.preventDefault();
                addByHand();
              }}
            />
            <Button variant="outline" disabled={draftId.trim().length === 0} onClick={addByHand}>
              <Plus />
              Add
            </Button>
          </div>
        </div>
        <DialogFooter>
          {fetching ? (
            <p className="mr-auto text-meta text-muted-foreground">
              Reading the provider's model list… saving now would store only what is already here.
            </p>
          ) : null}
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={fetching || save.isPending} onClick={() => save.mutate()}>
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/** How many rows a group draws before asking to be told to draw more. A provider with hundreds of models is ordinary; rendering all of them is not. */
const groupPageSize = 100;

function ModelGroup({
  heading,
  note,
  ids,
  stored,
  listed,
  selected,
  roles,
  allModels,
  defaultRoles,
  onToggle,
  onToggleRole,
}: {
  heading: string;
  note?: string;
  ids: string[];
  stored: Map<string, CatalogEntry>;
  listed: Set<string>;
  selected: string[];
  roles: Record<string, ModelRole[]>;
  allModels: boolean;
  defaultRoles: (id: string) => ModelRole[];
  onToggle: (id: string, enabled: boolean) => void;
  onToggleRole: (id: string, role: ModelRole, checked: boolean) => void;
}) {
  const [cap, setCap] = useState(groupPageSize);
  if (ids.length === 0) return null;
  const shown = ids.slice(0, cap);
  const hidden = ids.length - shown.length;

  return (
    <section>
      <h4 className="text-chrome font-medium">
        {heading} <span className="text-muted-foreground">({ids.length})</span>
      </h4>
      {note ? <p className="mt-0.5 text-meta text-muted-foreground">{note}</p> : null}
      <div className="mt-2 divide-y rounded-md border">
        {shown.map((id) => {
          const enabled = allModels || selected.includes(id);
          const entry = stored.get(id);
          const chosenRoles = roles[id] ?? defaultRoles(id);
          return (
            <div
              key={id}
              className="grid gap-3 px-3 py-3 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center"
            >
              <label htmlFor={`model-enabled-${id}`} className="flex min-w-0 items-start gap-3">
                <Checkbox
                  id={`model-enabled-${id}`}
                  checked={enabled}
                  disabled={allModels}
                  onCheckedChange={(checked) => onToggle(id, checked === true)}
                />
                <span className="min-w-0">
                  <span className="block font-medium text-chrome">{id}</span>
                  <span className="block truncate text-meta text-muted-foreground">
                    {entry?.label && entry.label !== id
                      ? entry.label
                      : listed.has(id)
                        ? "Listed by the provider."
                        : "Not in the provider's list."}
                  </span>
                </span>
              </label>
              <div className="flex flex-wrap items-center gap-3">
                {roleDescriptions.map((role) => (
                  <label
                    key={role.role}
                    htmlFor={`model-role-${id}-${role.role}`}
                    className="flex items-center gap-1.5 text-meta text-muted-foreground"
                  >
                    <Checkbox
                      id={`model-role-${id}-${role.role}`}
                      checked={chosenRoles.includes(role.role)}
                      disabled={!enabled}
                      onCheckedChange={(checked) => onToggleRole(id, role.role, checked === true)}
                    />
                    {role.label}
                  </label>
                ))}
              </div>
            </div>
          );
        })}
        {hidden > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-3 px-3 py-2.5">
            <p className="text-meta text-muted-foreground">
              {hidden} more not shown. Search to narrow the list.
            </p>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setCap((current) => current + groupPageSize)}
            >
              Show more
            </Button>
          </div>
        ) : null}
      </div>
    </section>
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
      description="Removing a provider takes its stored credential with it. Role assignments keep their remaining entries."
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
