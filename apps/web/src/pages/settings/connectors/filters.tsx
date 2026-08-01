import { FilterBar, FilterSearch, FilterSelect } from "#web/components/trema/filter-bar.tsx";
import { fuzzyMatch } from "#web/lib/fuzzy.ts";
import { type CatalogProvider, categoryLabel } from "#web/pages/settings/connectors/shared.tsx";

type FilterOption = { value: string; label: string };

export function ConnectorFilters({
  search,
  onSearchChange,
  category,
  onCategoryChange,
  categoryOptions,
  kindLabel,
  kind,
  onKindChange,
  kindOptions,
}: {
  search: string;
  onSearchChange: (value: string) => void;
  category: string;
  onCategoryChange: (value: string) => void;
  categoryOptions: FilterOption[];
  kindLabel: string;
  kind: string;
  onKindChange: (value: string) => void;
  kindOptions: FilterOption[];
}) {
  return (
    <FilterBar>
      <FilterSearch
        value={search}
        onValueChange={onSearchChange}
        placeholder="Search connectors…"
      />
      <FilterSelect
        label="Category"
        value={category}
        onValueChange={onCategoryChange}
        options={categoryOptions}
      />
      <FilterSelect
        label={kindLabel}
        value={kind}
        onValueChange={onKindChange}
        options={kindOptions}
      />
    </FilterBar>
  );
}

export function connectorCategoryOptions(providers: readonly CatalogProvider[]): FilterOption[] {
  const categories = new Map<string, string>();
  for (const provider of providers) {
    for (const category of provider.categories) {
      const value = category.toLowerCase();
      if (!categories.has(value)) categories.set(value, categoryLabel([category]));
    }
  }
  return [
    { value: "all", label: "All categories" },
    ...[...categories]
      .map(([value, label]) => ({ value, label }))
      .sort((left, right) => left.label.localeCompare(right.label)),
  ];
}

export function filterConnectorRows<T>({
  rows,
  search,
  category,
  providerOf,
  extraFieldsOf,
}: {
  rows: readonly T[];
  search: string;
  category: string;
  providerOf: (row: T) => CatalogProvider;
  extraFieldsOf?: ((row: T) => readonly string[]) | undefined;
}): T[] {
  const needle = search.trim();
  return rows
    .filter((row) => {
      const provider = providerOf(row);
      return (
        category === "all" ||
        provider.categories.some((candidate) => candidate.toLowerCase() === category)
      );
    })
    .map((row) => {
      if (needle === "") return { row, score: 0 };
      const provider = providerOf(row);
      return {
        row,
        score: fuzzyMatch(needle, [
          provider.displayName,
          provider.key,
          ...provider.categories,
          categoryLabel(provider.categories),
          ...(extraFieldsOf?.(row) ?? []),
        ]),
      };
    })
    .filter((result) => result.score !== undefined)
    .sort((left, right) => (right.score ?? 0) - (left.score ?? 0))
    .map(({ row }) => row);
}
