import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useMemo, useState } from "react";

import { DataTable, type DataTableColumn } from "#web/components/trema/data-table.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { FilterBar, FilterCombobox } from "#web/components/trema/filter-bar.tsx";
import { IdChip } from "#web/components/trema/id-chip.tsx";
import { KeyValueList } from "#web/components/trema/key-value-list.tsx";
import { OutputViewer } from "#web/components/trema/output-viewer.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Input } from "#web/components/ui/input.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "#web/components/ui/sheet.tsx";
import { orpc } from "#web/lib/api.ts";

type AuditEntry = {
  id: string;
  action: string;
  subject: string;
  actor: { id: string; displayName: string; kind: "human" | "agent" } | null;
  payload: unknown;
  createdAt: string;
};

type Member = {
  principal: { id: string; displayName: string };
};

type ActorOption = { value: string; label: string };

const allActors: ActorOption = { value: "all", label: "All actors" };

const timeFormat = new Intl.DateTimeFormat(undefined, {
  year: "numeric",
  month: "short",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
  second: "2-digit",
  hour12: false,
});

function formatTime(value: string) {
  return timeFormat.format(new Date(value));
}

function startOfDay(value: string) {
  return value ? new Date(`${value}T00:00:00`).toISOString() : undefined;
}

function endOfDay(value: string) {
  return value ? new Date(`${value}T23:59:59.999`).toISOString() : undefined;
}

function ActorName({ entry }: { entry: AuditEntry }) {
  if (!entry.actor) {
    return <span className="text-muted-foreground">System</span>;
  }
  return <span>{entry.actor.displayName}</span>;
}

export function SettingsAuditPage() {
  const [action, setAction] = useState("all");
  const [actor, setActor] = useState<ActorOption>(allActors);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [selectedId, setSelectedId] = useState<string>();

  const actions = useQuery(orpc.audit.actions.queryOptions());
  const members = useQuery(orpc.members.list.queryOptions({}));
  const rangeStart = startOfDay(from);
  const rangeEnd = endOfDay(to);
  const entries = useInfiniteQuery(
    orpc.audit.list.infiniteOptions({
      input: (cursor: string | undefined) => ({
        ...(action === "all" ? {} : { action }),
        ...(actor.value === allActors.value ? {} : { actorPrincipalId: actor.value }),
        ...(rangeStart ? { from: rangeStart } : {}),
        ...(rangeEnd ? { to: rangeEnd } : {}),
        ...(cursor ? { cursor } : {}),
      }),
      initialPageParam: undefined as string | undefined,
      getNextPageParam: (page) => page.nextCursor ?? undefined,
    }),
  );

  const rows = useMemo(
    () => (entries.data?.pages ?? []).flatMap((page) => page.entries as AuditEntry[]),
    [entries.data],
  );
  const selected = rows.find((entry) => entry.id === selectedId);
  const actionOptions = [
    { value: "all", label: "All actions" },
    ...(actions.data ?? []).map((value) => ({ value, label: value })),
  ];
  // Members plus every actor the loaded rows mention, so the agent principal and
  // anyone no longer a member stay selectable.
  const actorOptions = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of (members.data ?? []) as Member[]) {
      names.set(member.principal.id, member.principal.displayName);
    }
    for (const entry of rows) {
      if (entry.actor) names.set(entry.actor.id, entry.actor.displayName);
    }
    if (actor.value !== allActors.value) names.set(actor.value, actor.label);
    return [
      allActors,
      ...[...names]
        .map(([value, label]) => ({ value, label }))
        .sort(
          (left, right) =>
            left.label.localeCompare(right.label) || left.value.localeCompare(right.value),
        ),
    ];
  }, [members.data, rows, actor]);
  const error = entries.error ?? actions.error;

  const columns: DataTableColumn<AuditEntry>[] = [
    {
      key: "time",
      header: "Time",
      width: "13rem",
      render: (entry) => (
        <span className="font-mono text-meta text-muted-foreground">
          {formatTime(entry.createdAt)}
        </span>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      width: "12rem",
      render: (entry) => <ActorName entry={entry} />,
    },
    {
      key: "action",
      header: "Action",
      render: (entry) => <span className="font-mono text-meta">{entry.action}</span>,
    },
    {
      key: "subject",
      header: "Subject",
      width: "10rem",
      render: (entry) => <IdChip id={entry.subject} />,
    },
  ];

  return (
    <main className="mx-auto w-full max-w-6xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Audit log"
        description="Every recorded change in the organization, newest first."
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}

      <div className="space-y-3">
        <FilterBar>
          <FilterCombobox
            label="Action"
            value={action}
            onValueChange={setAction}
            options={actionOptions}
            searchPlaceholder="Search actions…"
            emptyLabel="No actions match"
          />
          <FilterCombobox
            label="Actor"
            value={actor.value}
            onValueChange={(value) =>
              setActor(actorOptions.find((option) => option.value === value) ?? allActors)
            }
            options={actorOptions}
            searchPlaceholder="Search actors…"
            emptyLabel="No actors match"
          />
          <Input
            type="date"
            aria-label="From date"
            value={from}
            max={to || undefined}
            onChange={(event) => setFrom(event.currentTarget.value)}
            className="h-8 w-40 bg-card text-(length:--text-chrome) shadow-none md:text-(length:--text-chrome) dark:bg-card"
          />
          <Input
            type="date"
            aria-label="To date"
            value={to}
            min={from || undefined}
            onChange={(event) => setTo(event.currentTarget.value)}
            className="h-8 w-40 bg-card text-(length:--text-chrome) shadow-none md:text-(length:--text-chrome) dark:bg-card"
          />
        </FilterBar>
        <DataTable
          columns={columns}
          rows={rows}
          rowKey={(entry) => entry.id}
          onRowClick={(entry) => setSelectedId(entry.id)}
          loading={entries.isPending}
          empty={
            <EmptyState
              icon={ScrollText}
              title="No audit entries"
              description="Entries appear here as members and the agent change the organization."
            />
          }
        />
        {entries.hasNextPage ? (
          <div className="flex justify-center">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={entries.isFetchingNextPage}
              onClick={() => void entries.fetchNextPage()}
            >
              {entries.isFetchingNextPage ? "Loading…" : "Load more"}
            </Button>
          </div>
        ) : null}
      </div>

      <Sheet
        open={selected !== undefined}
        onOpenChange={(open) => {
          if (!open) setSelectedId(undefined);
        }}
      >
        {selected ? <AuditEntrySheetContent entry={selected} /> : null}
      </Sheet>
    </main>
  );
}

function AuditEntrySheetContent({ entry }: { entry: AuditEntry }) {
  return (
    <SheetContent className="overflow-y-auto sm:max-w-xl">
      <SheetHeader className="border-b">
        <SheetTitle className="font-mono text-(length:--text-chrome)">{entry.action}</SheetTitle>
        <SheetDescription>What was recorded for this change.</SheetDescription>
      </SheetHeader>
      <div className="space-y-4 px-4 pb-4">
        <KeyValueList
          items={[
            {
              label: "Time",
              value: (
                <span className="flex items-baseline gap-2">
                  <span className="font-mono text-meta">{formatTime(entry.createdAt)}</span>
                  <RelativeTime date={entry.createdAt} />
                </span>
              ),
            },
            {
              label: "Actor",
              value: entry.actor ? (
                <span className="flex items-baseline gap-2">
                  {entry.actor.displayName}
                  <IdChip id={entry.actor.id} />
                </span>
              ) : (
                <span className="text-muted-foreground">System</span>
              ),
            },
            { label: "Subject", value: entry.subject, mono: true },
            { label: "Entry ID", value: entry.id, mono: true },
          ]}
        />
        <div className="space-y-1.5">
          <p className="text-chrome font-medium">Payload</p>
          <OutputViewer output={{ type: "json", value: entry.payload }} />
        </div>
      </div>
    </SheetContent>
  );
}
