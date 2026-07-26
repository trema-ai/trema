import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, ChevronDown, Plus } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
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
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#web/components/ui/command.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#web/components/ui/popover.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { AvailableModelsRow } from "#web/pages/settings/models/catalog.tsx";
import { CreateProviderDialog } from "#web/pages/settings/models/create-dialog.tsx";
import { ProviderLogo } from "#web/pages/settings/models/provider-logo.tsx";
import {
  type CatalogEntry,
  type ChainEntry,
  type IndexStatus,
  type ModelProvider,
  messageFrom,
  modelDisplayName,
  protocolLabel,
  type RoleDefault,
  type RoleDescription,
  roleDescriptions,
} from "#web/pages/settings/models/shared.tsx";

/** The embedding role rebuilds the index when it changes; the others just save. */
const embedCardProps = { reindexes: true };

/** What a role assignment did: the rebuild it ran, or the one that would not run. */
type SaveOutcome = { embedded?: number; rebuildError?: string };

export function SettingsModelsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const providers = useQuery(orpc.modelProviders.providers.list.queryOptions({}));
  const defaults = useQuery(orpc.modelProviders.defaults.list.queryOptions({}));
  const [adding, setAdding] = useState(false);
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

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Models"
        description="The providers this organization can call, and the models it runs on."
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
          <section data-slot="settings-section">
            <h3 className="text-chrome font-medium text-foreground">Available models</h3>
            <div className="mt-2 rounded-md border bg-card">
              <AvailableModelsRow providers={providerRows} onChanged={invalidate} />
            </div>
          </section>
          <section data-slot="settings-section">
            <h3 className="text-chrome font-medium text-foreground">Default models</h3>
            <div className="mt-2 divide-y rounded-md border bg-card">
              {roleDescriptions.map((role) => (
                <RoleCard
                  key={role.role}
                  role={role}
                  chain={defaultRows.find((entry) => entry.role === role.role)?.chain ?? []}
                  providers={providerRows}
                  onChanged={invalidate}
                  {...(role.role === "embed" ? embedCardProps : {})}
                />
              ))}
              <EmbeddingIndexCard />
            </div>
          </section>
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
  const summary = [
    provider.name,
    protocolLabel(provider.protocol),
    `${provider.catalog.length} model${provider.catalog.length === 1 ? "" : "s"}`,
  ].join(" · ");
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
        </span>
      </button>
      <Button size="sm" variant="outline" onClick={onOpen}>
        Configure
      </Button>
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
    <>
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
    </>
  );
}

function RoleCard({
  role,
  chain,
  providers,
  onChanged,
  note,
  reindexes,
}: {
  role: RoleDescription;
  chain: ChainEntry[];
  providers: ModelProvider[];
  onChanged: () => Promise<void>;
  /** What assigning this role costs, stated where the assignment is made. */
  note?: string;
  /** Whether picking a model here rebuilds the search index with it. */
  reindexes?: boolean;
}) {
  const queryClient = useQueryClient();
  // Held while the confirmation is open, because rebuilding the index is the
  // expensive half of this change and the admin should agree to it first.
  const [pending, setPending] = useState<ChainEntry>();
  // The registry stores an ordered chain and resolves down it, taking the first
  // entry whose provider is still there. This screen assigns a chain of one, but
  // a longer one written through the API resolves the same way, so the row shows
  // the entry that would run rather than the head of the list.
  const assigned =
    chain.find((entry) => providers.some((row) => row.name === entry.providerName)) ?? chain[0];
  const provider = providers.find((row) => row.name === assigned?.providerName);
  const model = provider?.catalog.find((entry) => entry.id === assigned?.modelId);
  const choices = providers.flatMap((row) =>
    row.catalog.map((entry) => ({ provider: row, entry })),
  );

  // A role is changed, never cleared: a deployment that had a model and now has
  // none is a worse state than one nobody configured, and nothing here should
  // walk an organization into it.
  const save = useMutation({
    mutationFn: async (next: ChainEntry): Promise<SaveOutcome> => {
      await rpcClient.modelProviders.defaults.put({ role: role.role, chain: [next] });
      // The index is only as good as the model that wrote it, so the rebuild
      // rides along with the change rather than waiting to be remembered. It is
      // reported rather than thrown: the assignment is already saved by now, and
      // a failed rebuild is a different sentence from a failed save.
      if (!reindexes) return {};
      try {
        const rebuilt = await rpcClient.items.reindex({});
        return { embedded: rebuilt.embedded };
      } catch (error) {
        return { rebuildError: messageFrom(error) };
      }
    },
    onSuccess: (result) => {
      if (result.rebuildError !== undefined) {
        toast.error(`${role.label} saved, but the rebuild failed: ${result.rebuildError}`);
        return;
      }
      toast.success(
        result.embedded === undefined
          ? `${role.label} saved`
          : `${role.label} saved, ${countFormat.format(result.embedded)} embedded`,
      );
    },
    onError: (error) => toast.error(messageFrom(error)),
    // Reload either way. A rebuild that failed still left the assignment
    // changed, and the index row is where that shows.
    onSettled: async () => {
      await onChanged();
      await queryClient.invalidateQueries({ queryKey: orpc.items.indexStatus.key() });
    },
  });

  const selected =
    assigned === undefined
      ? undefined
      : `${model ? modelDisplayName(model) : assigned.modelId} on ${provider?.label ?? assigned.providerName}`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
      <div className="min-w-0">
        <p className="text-chrome font-medium">{role.label}</p>
        <p className="mt-0.5 text-meta text-muted-foreground">{role.description}</p>
        {provider === undefined && assigned !== undefined ? (
          <p className="mt-0.5 text-meta text-muted-foreground">
            Its provider is gone, so this role cannot resolve.
          </p>
        ) : null}
        {note ? <p className="mt-0.5 text-meta text-muted-foreground">{note}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {choices.length === 0 ? (
          <p className="text-meta text-muted-foreground">No model to choose from yet.</p>
        ) : (
          <ModelCombobox
            label={role.label}
            selected={selected}
            busy={save.isPending}
            choices={choices}
            onPick={(entry) => (reindexes ? setPending(entry) : save.mutate(entry))}
          />
        )}
      </div>
      <AlertDialog
        open={pending !== undefined}
        onOpenChange={(open) => {
          if (!open) setPending(undefined);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Rebuild the index with this model?</AlertDialogTitle>
            <AlertDialogDescription>
              Vectors written by the old model stop counting the moment this changes. The rebuild
              re-embeds everything indexed and runs while you wait; until it finishes, search
              matches on text alone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (pending !== undefined) save.mutate(pending);
                setPending(undefined);
              }}
            >
              Change and rebuild
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}

function ModelCombobox({
  label,
  selected,
  busy,
  choices,
  onPick,
}: {
  label: string;
  /** What the role resolves to today, or undefined while it is unassigned. */
  selected?: string | undefined;
  busy: boolean;
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
          aria-label={`Choose a model for ${label}`}
          disabled={busy}
          className="w-64 max-w-full justify-between font-normal"
        >
          <span className="truncate">{selected ?? "Choose a model"}</span>
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
