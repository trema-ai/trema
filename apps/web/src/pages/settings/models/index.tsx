import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Boxes, ChevronDown, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router";
import { toast } from "sonner";

import { CredentialStatusBadge } from "#web/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#web/components/ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#web/components/ui/popover.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#web/components/ui/tabs.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { ModelsSection } from "#web/pages/settings/models/catalog.tsx";
import { CreateProviderDialog } from "#web/pages/settings/models/create-dialog.tsx";
import { ProviderLogo } from "#web/pages/settings/models/provider-logo.tsx";
import {
  type CatalogEntry,
  type ChainEntry,
  credentialModeLabel,
  defaultModality,
  type IndexStatus,
  modalities,
  type ModelProvider,
  messageFrom,
  modelDisplayName,
  type ProbeResult,
  protocolLabel,
  type RoleDefault,
  type RoleDescription,
} from "#web/pages/settings/models/shared.tsx";

/** What the embedding role costs to change, and the completion roles do not. */
const embedCardProps = {
  note: "The model is part of the index: vectors written by an earlier one stop counting the moment this changes, and search runs on text alone until the index is rebuilt below.",
};

export function SettingsModelsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  const providers = useQuery(orpc.modelProviders.providers.list.queryOptions({}));
  const defaults = useQuery(orpc.modelProviders.defaults.list.queryOptions({}));
  const [adding, setAdding] = useState(false);
  const requested = searchParams.get("tab");
  // A link naming a tab this build does not have opens the default one rather
  // than a page with nothing on it.
  const tab = modalities.find((modality) => modality.id === requested)?.id ?? defaultModality;
  const providerRows = (providers.data ?? []) as ModelProvider[];
  const defaultRows = (defaults.data ?? []) as RoleDefault[];
  const error = providers.error ?? defaults.error;
  const pending = providers.isPending || defaults.isPending;

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.providers.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.defaults.list.key() }),
    ]);
  }

  function selectTab(next: string) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("tab", next);
        return params;
      },
      { replace: true },
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Models"
        description="The providers this organization can call, and which model serves each kind of work."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add provider
          </Button>
        }
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <div className="space-y-4">
          {[1, 2].map((key) => (
            <div key={key} className="h-40 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      ) : (
        <div className="space-y-7">
          <section data-slot="settings-section">
            <h3 className="text-chrome font-medium text-foreground">Providers</h3>
            <div className="mt-2 divide-y rounded-md border bg-card">
              {providerRows.length === 0 ? (
                <EmptyState
                  icon={Boxes}
                  title="No providers yet"
                  description="Add one to give the agent a model to run on."
                  action={<Button onClick={() => setAdding(true)}>Add provider</Button>}
                />
              ) : (
                providerRows.map((provider) => (
                  <ProviderRow
                    key={provider.name}
                    provider={provider}
                    onOpen={() => navigate(`/settings/models/${provider.name}`)}
                  />
                ))
              )}
            </div>
          </section>
          <ModelsSection providers={providerRows} onChanged={invalidate} />
          <Tabs value={tab} onValueChange={selectTab}>
            <TabsList className="mb-2">
              {modalities.map((modality) => (
                <TabsTrigger key={modality.id} value={modality.id}>
                  {modality.label}
                </TabsTrigger>
              ))}
            </TabsList>
            {modalities.map((modality) => (
              <TabsContent key={modality.id} value={modality.id} className="space-y-3">
                <p className="text-meta text-muted-foreground">{modality.description}</p>
                {modality.roles.map((role) => (
                  <RoleCard
                    key={role.role}
                    role={role}
                    chain={defaultRows.find((entry) => entry.role === role.role)?.chain ?? []}
                    providers={providerRows}
                    onChanged={invalidate}
                    {...(role.role === "embed" ? embedCardProps : {})}
                  />
                ))}
                {modality.id === "embeddings" ? <EmbeddingIndexCard /> : null}
              </TabsContent>
            ))}
          </Tabs>
        </div>
      )}
      <CreateProviderDialog
        open={adding}
        onOpenChange={setAdding}
        existingNames={providerRows.map((provider) => provider.name)}
        // The models it just read are on this screen, so it stays here rather
        // than opening the endpoint page nobody asked for.
        onCreated={async () => {
          setAdding(false);
          await invalidate();
        }}
      />
    </main>
  );
}

function ProviderRow({ provider, onOpen }: { provider: ModelProvider; onOpen: () => void }) {
  const [result, setResult] = useState<ProbeResult>();
  const probe = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.probe({ name: provider.name }),
    onSuccess: (probed) => setResult(probed),
    onError: (error) => toast.error(messageFrom(error)),
  });
  const summary = [
    provider.name,
    protocolLabel(provider.protocol),
    `${provider.catalog.length} model${provider.catalog.length === 1 ? "" : "s"}`,
  ].join(" · ");
  const keyed = provider.credentialMode === "api_key";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
      >
        <ProviderLogo
          name={provider.name}
          label={provider.label}
          baseUrl={provider.baseUrl}
          className="size-8"
        />
        <span className="min-w-0">
          <span className="block text-chrome font-medium">{provider.label}</span>
          <span className="mt-0.5 block truncate text-meta text-muted-foreground">{summary}</span>
          {result ? (
            <span className="mt-1 block text-meta text-muted-foreground">
              {result.ok
                ? `Answered in ${result.latencyMs} ms${
                    result.modelCount === undefined ? "" : `, listing ${result.modelCount} models`
                  }.`
                : result.reason}
            </span>
          ) : null}
        </span>
      </button>
      <div className="flex items-center gap-2">
        {/* A provider in key mode always has one stored: the registry refuses the other state. */}
        <CredentialStatusBadge
          status="connected"
          label={keyed ? "Key stored" : credentialModeLabel("none")}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? "Checking…" : "Check"}
        </Button>
      </div>
    </div>
  );
}

const countFormat = new Intl.NumberFormat();

/** What the index is built from today, and what a reindex would change about it. */
function indexSummary(status: IndexStatus): string {
  if (status.documents === 0) return "Nothing is indexed yet.";
  const items = `${countFormat.format(status.documents)} item${status.documents === 1 ? "" : "s"}`;
  if (status.model === undefined) {
    const built = status.models.map((entry) => entry.model).join(", ");
    const vectors =
      status.embedded === 0
        ? "None of them are embedded."
        : `The ${countFormat.format(status.embedded)} vectors stored from ${built} are ignored.`;
    // A role that is assigned but resolves to nothing is a different problem
    // from one nobody set, and it is not one a reindex fixes.
    return status.assigned
      ? `${items} indexed. ${vectors} The assigned model cannot be reached: its provider is gone, or its credential cannot be read.`
      : `${items} indexed. ${vectors} Search matches on text alone.`;
  }
  const stale = status.stale ?? 0;
  if (stale === 0) return `${items} indexed, all of them embedded with ${status.model}.`;
  return `${countFormat.format(stale)} of ${items} still need embedding with ${status.model}. Until they are, those items match on text alone.`;
}

function EmbeddingIndexCard() {
  const queryClient = useQueryClient();
  const query = useQuery(orpc.items.indexStatus.queryOptions({}));
  const status = query.data as IndexStatus | undefined;
  const reindex = useMutation({
    mutationFn: () => rpcClient.items.reindex({}),
    onSuccess: async (result) => {
      await queryClient.invalidateQueries({ queryKey: orpc.items.indexStatus.key() });
      toast.success(
        result.failed === 0
          ? `Embedded ${countFormat.format(result.embedded)} items`
          : `Embedded ${countFormat.format(result.embedded)} items, ${countFormat.format(result.failed)} failed`,
      );
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="text-chrome font-medium">Index</p>
          <p className="mt-0.5 text-meta text-muted-foreground">
            {query.error
              ? query.error.message
              : status === undefined
                ? "Reading the index…"
                : indexSummary(status)}
          </p>
          {status && status.documents > 0 ? (
            <p className="mt-0.5 text-meta text-muted-foreground">
              A rebuild embeds everything that needs it, and runs while you wait.
            </p>
          ) : null}
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={reindex.isPending || status === undefined}
          onClick={() => reindex.mutate()}
        >
          {reindex.isPending ? "Rebuilding…" : "Rebuild index"}
        </Button>
      </div>
      {status && status.models.length > 1 ? (
        <div className="border-t px-4 py-3">
          <p className="text-meta text-muted-foreground">
            Vectors in the index came from{" "}
            {status.models
              .map((entry) => `${entry.model} (${countFormat.format(entry.count)})`)
              .join(", ")}
            . A rebuild settles them on one model.
          </p>
        </div>
      ) : null}
    </div>
  );
}

function withoutRepeats(chain: ChainEntry[]): ChainEntry[] {
  const seen = new Set<string>();
  return chain.filter((entry) => {
    const key = `${entry.providerName}\u0000${entry.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function RoleCard({
  role,
  chain,
  providers,
  onChanged,
  note,
}: {
  role: RoleDescription;
  chain: ChainEntry[];
  providers: ModelProvider[];
  onChanged: () => Promise<void>;
  /** What assigning this role costs, stated where the assignment is made. */
  note?: string;
}) {
  const [draft, setDraft] = useState<ChainEntry[]>(() => withoutRepeats(chain));
  // A chain written through the API can name the same model twice, where only
  // the first entry can ever be reached. The editor shows the chain that runs.
  const stored = JSON.stringify(withoutRepeats(chain));
  useEffect(() => {
    setDraft(JSON.parse(stored) as ChainEntry[]);
  }, [stored]);
  const dirty = JSON.stringify(draft) !== stored;
  const choices = providers.flatMap((provider) =>
    provider.catalog.map((entry) => ({ provider, entry })),
  );

  const save = useMutation({
    mutationFn: async () => {
      if (draft.length === 0) await rpcClient.modelProviders.defaults.delete({ role: role.role });
      else await rpcClient.modelProviders.defaults.put({ role: role.role, chain: draft });
    },
    onSuccess: async () => {
      await onChanged();
      toast.success(draft.length === 0 ? `${role.label} unassigned` : `${role.label} saved`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function move(index: number, by: number) {
    setDraft((current) => {
      const next = [...current];
      const [entry] = next.splice(index, 1);
      if (entry) next.splice(index + by, 0, entry);
      return next;
    });
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="text-chrome font-medium">{role.label}</p>
          <p className="mt-0.5 text-meta text-muted-foreground">{role.description}</p>
        </div>
        {dirty ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(JSON.parse(stored) as ChainEntry[])}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="border-t px-4 py-3">
        {draft.length === 0 ? (
          <p className="text-meta text-muted-foreground">{role.unassigned}</p>
        ) : (
          <ol className="space-y-1.5">
            {draft.map((entry, index) => {
              const provider = providers.find((row) => row.name === entry.providerName);
              const model = provider?.catalog.find((candidate) => candidate.id === entry.modelId);
              return (
                <li
                  key={`${entry.providerName}-${entry.modelId}`}
                  className="flex items-center gap-2"
                >
                  <span className="w-4 shrink-0 text-meta text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-chrome">
                    {model ? modelDisplayName(model) : entry.modelId}
                    <span className="text-muted-foreground">
                      {" "}
                      on {provider?.label ?? entry.providerName}
                    </span>
                    {provider ? null : (
                      <span className="text-muted-foreground"> · provider is gone</span>
                    )}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${entry.modelId} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${entry.modelId} down`}
                    disabled={index === draft.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${entry.modelId}`}
                    onClick={() =>
                      setDraft((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        {note ? <p className="mt-3 text-meta text-muted-foreground">{note}</p> : null}
        <div className="mt-3">
          {choices.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              No model is available for this role yet. Add a provider, or refresh one from its page.
            </p>
          ) : (
            <ModelCombobox
              label={role.label}
              choices={choices.filter(
                ({ provider, entry }) =>
                  !draft.some(
                    (existing) =>
                      existing.providerName === provider.name && existing.modelId === entry.id,
                  ),
              )}
              onPick={(entry) => setDraft((current) => [...current, entry])}
            />
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Picks one model out of the whole catalog. It searches rather than scrolls
 * because a gateway lists hundreds, and it offers every model a provider serves
 * rather than guessing which suit the role — a name is not a capability.
 */
function ModelCombobox({
  label,
  choices,
  onPick,
}: {
  label: string;
  choices: { provider: ModelProvider; entry: CatalogEntry }[];
  onPick: (entry: ChainEntry) => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          size="sm"
          variant="outline"
          role="combobox"
          aria-expanded={open}
          aria-label={`Add a model to ${label}`}
          className="w-full justify-between font-normal"
        >
          Add a model
          <ChevronDown className="opacity-50" />
        </Button>
      </PopoverTrigger>
      <PopoverContent align="start" className="w-(--radix-popover-trigger-width) p-0">
        <Command
          filter={(_value, search, keywords) =>
            (keywords ?? []).join(" ").toLowerCase().includes(search.trim().toLowerCase()) ? 1 : 0
          }
        >
          <CommandInput placeholder="Search models…" />
          <CommandList>
            <CommandEmpty>No model matches.</CommandEmpty>
            <CommandGroup>
              {choices.map(({ provider, entry }) => (
                <CommandItem
                  key={`${provider.name} ${entry.id}`}
                  value={`${provider.name} ${entry.id}`}
                  keywords={[entry.id, modelDisplayName(entry), provider.label]}
                  onSelect={() => {
                    onPick({ providerName: provider.name, modelId: entry.id });
                    setOpen(false);
                  }}
                >
                  <span className="min-w-0 flex-1 truncate">
                    {modelDisplayName(entry)}
                    <span className="text-muted-foreground"> on {provider.label}</span>
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
