import { useQuery } from "@tanstack/react-query";
import { Brain } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";

import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { FilterBar, FilterSearch, FilterSelect } from "#/components/trema/filter-bar.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { StatusDot } from "#/components/trema/status-dot.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import { orpc } from "#/lib/api.ts";
import { ConnectionsTab } from "#/pages/customize/connections.tsx";
import { InstructionsTab } from "#/pages/customize/instructions.tsx";
import { ItemEditorSheet } from "#/pages/customize/item-editor.tsx";
import { SkillsTab } from "#/pages/customize/skills.tsx";
import {
  type Item,
  type MemoryBody,
  orderScopes,
  type Scope,
} from "#/pages/customize/types.ts";
import { useAuthenticatedSession } from "#/pages/home.tsx";

const statusTone = { active: "go", proposed: "wait", archived: "neutral" } as const;

function ItemStatus({ status }: { status: Item["status"] }) {
  return (
    <span className="inline-flex items-center gap-1.5 capitalize">
      <StatusDot tone={statusTone[status]} />
      {status}
    </span>
  );
}

export function CustomizePage() {
  const session = useAuthenticatedSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const items = useQuery(orpc.items.list.queryOptions({ input: {} }));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const tab = searchParams.get("tab") ?? "memory";
  const allScopes = (scopes.data ?? []) as Scope[];
  const principalId = session.membership.principal.id;
  // scopes.list includes every member's personal scope for admins (the admin
  // area needs them); this member-facing screen only ever shows your own.
  const visibleScopes = useMemo(
    () =>
      orderScopes(
        allScopes.filter((scope) => scope.kind !== "personal" || scope.ownerId === principalId),
      ),
    [allScopes, principalId],
  );
  const personalScope = visibleScopes.find((scope) => scope.kind === "personal");
  const orgScope = visibleScopes.find((scope) => scope.kind === "org");
  const scopeParam = searchParams.get("scope");
  // No URL normalization: the param is only ever written by an explicit pick,
  // so the default stays Personal even when it appears later (backfill, policy).
  const selectedScope =
    visibleScopes.find((scope) => scope.id === scopeParam) ?? personalScope ?? orgScope;

  const allItems = (items.data ?? []) as Item[];
  const scopedItems = useMemo(
    () => allItems.filter((item) => item.scopeId === selectedScope?.id),
    [allItems, selectedScope?.id],
  );
  const error = items.error ?? scopes.error;
  const loading = items.isPending || scopes.isPending;

  function selectTab(next: string) {
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("tab", next);
        params.delete("skill");
        return params;
      },
      { replace: true },
    );
  }

  function selectScope(id: string) {
    setSearchParams((current) => {
      const params = new URLSearchParams(current);
      params.set("scope", id);
      params.delete("skill");
      return params;
    });
  }

  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Customize"
        description="What the agent knows and may use: memories, instructions, skills, and connections."
      />
      {error ? (
        <Alert variant="destructive">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : (
        <Tabs value={tab} onValueChange={selectTab}>
          <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
            <TabsList>
              <TabsTrigger value="memory">Memory</TabsTrigger>
              <TabsTrigger value="instructions">Instructions</TabsTrigger>
              <TabsTrigger value="skills">Skills</TabsTrigger>
              <TabsTrigger value="connections">Connections</TabsTrigger>
            </TabsList>
            {!loading && selectedScope ? (
              <Select value={selectedScope.id} onValueChange={selectScope}>
                <SelectTrigger aria-label="Scope" className="min-w-44 capitalize">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent align="end">
                  {visibleScopes.map((scope) => (
                    <SelectItem key={scope.id} value={scope.id} className="capitalize">
                      {scope.kind === "shared" ? scope.name : scope.kind}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            ) : null}
          </div>
          <TabsContent value="memory">
            <MemoryTab items={scopedItems} loading={loading} />
          </TabsContent>
          <TabsContent value="instructions">
            {selectedScope ? (
              <InstructionsTab
                items={allItems}
                scope={selectedScope}
                orgScope={orgScope}
                loading={loading}
              />
            ) : null}
          </TabsContent>
          <TabsContent value="skills">
            <SkillsTab items={scopedItems} loading={loading} />
          </TabsContent>
          <TabsContent value="connections">
            {selectedScope ? (
              <ConnectionsTab items={scopedItems} scope={selectedScope} loading={loading} />
            ) : null}
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

function MemoryTab({ items, loading }: { items: Item[]; loading: boolean }) {
  const [search, setSearch] = useState("");
  const [typeFilter, setTypeFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("active");
  const [selectedId, setSelectedId] = useState<string>();
  const selected = items.find((item) => item.id === selectedId);

  const rows = useMemo(() => {
    const query = search.trim().toLowerCase();
    return items.filter((item) => {
      if (item.kind !== "memory") return false;
      const body = item.body as MemoryBody;
      if (statusFilter !== "all" && item.status !== statusFilter) return false;
      if (typeFilter !== "all" && body.type !== typeFilter) return false;
      if (
        query &&
        !item.title.toLowerCase().includes(query) &&
        !body.content.toLowerCase().includes(query)
      )
        return false;
      return true;
    });
  }, [items, search, typeFilter, statusFilter]);

  const columns: DataTableColumn<Item>[] = [
    {
      key: "memory",
      header: "Memory",
      render: (item) => (
        <div className="min-w-0">
          <p className="truncate font-medium">{item.title}</p>
          <p className="truncate text-meta text-muted-foreground">
            {(item.body as MemoryBody).content}
          </p>
        </div>
      ),
    },
    {
      key: "type",
      header: "Type",
      width: "7rem",
      render: (item) => <span className="capitalize">{(item.body as MemoryBody).type}</span>,
    },
    {
      key: "status",
      header: "Status",
      width: "7rem",
      render: (item) => <ItemStatus status={item.status} />,
    },
    {
      key: "lastUsed",
      header: "Last used",
      width: "8rem",
      render: (item) =>
        item.lastUsedAt ? (
          <RelativeTime date={item.lastUsedAt} />
        ) : (
          <span className="text-muted-foreground">Never</span>
        ),
    },
  ];

  return (
    <div className="space-y-3">
      <FilterBar>
        <FilterSearch value={search} onValueChange={setSearch} placeholder="Search memories…" />
        <FilterSelect
          label="Type"
          value={typeFilter}
          onValueChange={setTypeFilter}
          options={[
            { value: "all", label: "All types" },
            { value: "fact", label: "Fact" },
            { value: "preference", label: "Preference" },
            { value: "rule", label: "Rule" },
            { value: "procedure", label: "Procedure" },
          ]}
        />
        <FilterSelect
          label="Status"
          value={statusFilter}
          onValueChange={setStatusFilter}
          options={[
            { value: "all", label: "All statuses" },
            { value: "active", label: "Active" },
            { value: "proposed", label: "Proposed" },
            { value: "archived", label: "Archived" },
          ]}
        />
      </FilterBar>
      <DataTable
        columns={columns}
        rows={rows}
        rowKey={(item) => item.id}
        onRowClick={(item) => setSelectedId(item.id)}
        loading={loading}
        pageSize={10}
        empty={
          <EmptyState
            icon={Brain}
            title="No memories in this scope yet"
            description="Memories appear here as the agent saves them from its sessions."
          />
        }
      />
      <ItemEditorSheet
        item={selected}
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedId(undefined);
        }}
      />
    </div>
  );
}
