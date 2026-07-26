import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { toast } from "sonner";

import { Button } from "#web/components/ui/button.tsx";
import { Checkbox } from "#web/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#web/components/ui/dialog.tsx";
import { Input } from "#web/components/ui/input.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { rpcClient } from "#web/lib/api.ts";
import {
  type CatalogEntry,
  descriptorOf,
  type ModelProvider,
  messageFrom,
} from "#web/pages/settings/models/shared.tsx";

/** How many rows the list draws. A gateway lists hundreds; search reaches the rest. */
const pageSize = 20;

/**
 * The provider filter's "every provider" value. A select item cannot carry an
 * empty string, so the unfiltered state needs a name of its own; the underscores
 * keep it clear of anything a provider is likely to be called.
 */
const allProviders = "__every__";

/** One model, and the provider that serves it. Model identity is the pair. */
type ModelRow = { provider: ModelProvider; entry: CatalogEntry };

function matches(row: ModelRow, needle: string): boolean {
  const haystack = [
    row.entry.id,
    row.entry.label ?? "",
    row.provider.label,
    row.provider.name,
  ].join(" ");
  return haystack.toLowerCase().includes(needle);
}

/** The entry a picker edit writes. Not offered is stored as no flag at all. */
function withOffered(entry: CatalogEntry, offered: boolean): CatalogEntry {
  return {
    id: entry.id,
    ...(entry.label === undefined ? {} : { label: entry.label }),
    ...(offered ? { offered: true } : {}),
    ...(entry.contextWindow === undefined ? {} : { contextWindow: entry.contextWindow }),
  };
}

/** One row of the Models card: what is on offer, and the way to change it. */
export function AvailableModelsRow({
  providers,
  onChanged,
}: {
  providers: ModelProvider[];
  onChanged: () => Promise<void>;
}) {
  const catalog = providers.flatMap((provider) => provider.catalog);
  const offered = catalog.filter((entry) => entry.offered === true).length;
  const summary =
    catalog.length === 0
      ? providers.length === 0
        ? "Add a provider and its list is read from the provider itself."
        : "Refresh a provider from its page to read what it serves."
      : `${offered} of ${catalog.length} offered in the model picker.`;

  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
      <p className="min-w-0 text-meta text-muted-foreground">{summary}</p>
      <Dialog>
        <DialogTrigger asChild>
          <Button size="sm" variant="outline" disabled={catalog.length === 0}>
            Select models
          </Button>
        </DialogTrigger>
        <DialogContent className="flex max-h-[80svh] flex-col gap-0 p-0 sm:max-w-2xl">
          <DialogHeader className="px-4 pt-4 pb-3">
            <DialogTitle>Models</DialogTitle>
            <DialogDescription>
              Select the models offered in the model picker. A role can name any model, selected or
              not.
            </DialogDescription>
          </DialogHeader>
          <ModelPicker providers={providers} onChanged={onChanged} />
        </DialogContent>
      </Dialog>
    </div>
  );
}

function ModelPicker({
  providers,
  onChanged,
}: {
  providers: ModelProvider[];
  onChanged: () => Promise<void>;
}) {
  const [search, setSearch] = useState("");
  const [providerName, setProviderName] = useState(allProviders);
  // Which provider has a write in flight. Every edit replaces that provider's
  // whole catalog, so a second edit on the same row set would race the first.
  const [writing, setWriting] = useState<string>();

  const scoped =
    providerName === allProviders
      ? providers
      : providers.filter((provider) => provider.name === providerName);
  const rows = scoped
    .flatMap((provider) => provider.catalog.map((entry) => ({ provider, entry })))
    // Offered models first: they are the short list the admin curates, and the
    // rest of the catalog is the hundreds they picked it out of.
    .sort((left, right) => {
      if ((left.entry.offered === true) !== (right.entry.offered === true)) {
        return left.entry.offered === true ? -1 : 1;
      }
      if (left.entry.id !== right.entry.id) return left.entry.id < right.entry.id ? -1 : 1;
      return left.provider.name < right.provider.name ? -1 : 1;
    });
  const needle = search.trim().toLowerCase();
  const filtered = needle === "" ? rows : rows.filter((row) => matches(row, needle));
  const shownRows = filtered.slice(0, pageSize);
  const hidden = filtered.length - shownRows.length;
  // Counted over every model, not the matches: the search and the provider
  // filter narrow what is on screen, never what is selected. Select all does
  // act on the matches, so the sentence says so while a filter is on.
  const all = providers.flatMap((provider) => provider.catalog);
  const offeredCount = all.filter((entry) => entry.offered === true).length;
  const narrowed = filtered.length !== all.length;

  const write = useMutation({
    mutationFn: ({ provider, catalog }: { provider: ModelProvider; catalog: CatalogEntry[] }) =>
      rpcClient.modelProviders.providers.put({ ...descriptorOf(provider), catalog }),
    onMutate: ({ provider }) => setWriting(provider.name),
    onSuccess: onChanged,
    onError: (error) => toast.error(messageFrom(error)),
    onSettled: () => setWriting(undefined),
  });

  function toggle(row: ModelRow, offered: boolean) {
    write.mutate({
      provider: row.provider,
      catalog: row.provider.catalog.map((entry) =>
        entry.id === row.entry.id ? withOffered(entry, offered) : entry,
      ),
    });
  }

  /**
   * Sets every model the filters currently name, one write per provider. It
   * follows the filters rather than the drawn page: the twenty rows on screen
   * are a window onto the match, not the match itself.
   */
  const setAll = useMutation({
    mutationFn: async (offered: boolean) => {
      const byProvider = new Map<string, ModelRow[]>();
      for (const row of filtered) {
        byProvider.set(row.provider.name, [...(byProvider.get(row.provider.name) ?? []), row]);
      }
      for (const group of byProvider.values()) {
        const provider = group[0]?.provider;
        if (provider === undefined) continue;
        const touched = new Set(group.map((row) => row.entry.id));
        await rpcClient.modelProviders.providers.put({
          ...descriptorOf(provider),
          catalog: provider.catalog.map((entry) =>
            touched.has(entry.id) ? withOffered(entry, offered) : entry,
          ),
        });
      }
    },
    onSuccess: onChanged,
    onError: (error) => toast.error(messageFrom(error)),
  });

  const busy = write.isPending || setAll.isPending;

  return (
    <>
      <div className="flex flex-wrap items-center gap-2 border-b px-4 py-3">
        <Input
          className="min-w-48 flex-1"
          aria-label="Search models"
          placeholder="Search models"
          value={search}
          onChange={(event) => setSearch(event.target.value)}
        />
        {providers.length > 1 ? (
          <Select value={providerName} onValueChange={setProviderName}>
            <SelectTrigger aria-label="Filter by provider" className="w-44">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={allProviders}>Every provider</SelectItem>
              {providers.map((provider) => (
                <SelectItem key={provider.name} value={provider.name}>
                  {provider.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        ) : null}
      </div>
      <div className="flex flex-wrap items-center justify-between gap-3 border-b px-4 py-2.5">
        <p className="text-meta text-muted-foreground">
          {offeredCount === 0
            ? `None of ${all.length} offered in the picker.`
            : `${offeredCount} of ${all.length} offered in the picker.`}
          {narrowed ? ` Select all covers the ${filtered.length} matching.` : ""}
        </p>
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || filtered.length === 0}
            onClick={() => setAll.mutate(true)}
          >
            Select all
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={busy || filtered.length === 0}
            onClick={() => setAll.mutate(false)}
          >
            Deselect all
          </Button>
        </div>
      </div>
      <div className="min-h-0 flex-1 divide-y overflow-y-auto">
        {shownRows.length === 0 ? (
          <p className="px-4 py-3.5 text-meta text-muted-foreground">
            No model matches. Widen the search or the provider filter.
          </p>
        ) : (
          shownRows.map((row) => (
            <ModelListRow
              key={[row.provider.name, row.entry.id].join("\u0000")}
              row={row}
              busy={setAll.isPending || (write.isPending && writing === row.provider.name)}
              onToggle={toggle}
            />
          ))
        )}
        {hidden > 0 ? (
          <p className="px-4 py-2.5 text-meta text-muted-foreground">
            {hidden} more not shown. Search, or filter by provider, to reach them.
          </p>
        ) : null}
      </div>
    </>
  );
}

function ModelListRow({
  row,
  busy,
  onToggle,
}: {
  row: ModelRow;
  /** This provider has a write in flight, and the next edit would race it. */
  busy: boolean;
  onToggle: (row: ModelRow, offered: boolean) => void;
}) {
  const { entry, provider } = row;
  const id = `model-offered-${provider.name}-${entry.id}`;
  return (
    <label htmlFor={id} className="flex items-center gap-3 px-4 py-3">
      <Checkbox
        id={id}
        checked={entry.offered === true}
        disabled={busy}
        onCheckedChange={(checked) => onToggle(row, checked === true)}
      />
      <span className="min-w-0 flex-1">
        <span className="block truncate text-chrome font-medium">{entry.id}</span>
        <span className="mt-0.5 block truncate text-meta text-muted-foreground">
          {provider.label}
          {entry.label && entry.label !== entry.id ? ` · ${entry.label}` : ""}
          {entry.contextWindow
            ? ` · ${new Intl.NumberFormat().format(entry.contextWindow)} tokens`
            : ""}
        </span>
      </span>
    </label>
  );
}
