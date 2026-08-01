import { useQuery } from "@tanstack/react-query";
import { LockKeyhole, ScrollText } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";

import { DataTable, type DataTableColumn } from "#web/components/trema/data-table.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { FilterBar, FilterSelect } from "#web/components/trema/filter-bar.tsx";
import { IdChip } from "#web/components/trema/id-chip.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { type RunState, RunStateBadge } from "#web/components/trema/run-state-badge.tsx";
import { orpc, type rpcClient } from "#web/lib/api.ts";

type RunList = Awaited<ReturnType<typeof rpcClient.runs.list>>;
type RunSummary = RunList["runs"][number];

type Trigger = RunSummary["trigger"];

const stateOptions = [
  { value: "all", label: "All states" },
  { value: "queued", label: "Queued" },
  { value: "running", label: "Running" },
  { value: "awaiting_approval", label: "Awaiting approval" },
  { value: "awaiting_input", label: "Awaiting input" },
  { value: "completed", label: "Completed" },
  { value: "failed", label: "Failed" },
  { value: "cancelled", label: "Cancelled" },
  { value: "stale", label: "Stale" },
] as const;

const triggerOptions = [
  { value: "all", label: "All triggers" },
  { value: "message", label: "Message" },
  { value: "api", label: "API" },
  { value: "schedule", label: "Schedule" },
  { value: "retry", label: "Retry" },
  { value: "resume", label: "Resume" },
] as const;

const triggerLabels: Record<Trigger, string> = {
  message: "Message",
  api: "API",
  schedule: "Schedule",
  retry: "Retry",
  resume: "Resume",
};

function sourceLabel(run: RunSummary) {
  if (run.access === "metadata") {
    return (
      <span className="flex items-center gap-1.5 text-muted-foreground">
        <LockKeyhole className="size-3.5" />
        Personal scope
      </span>
    );
  }
  if (run.surface === "web") return "Web";
  return (
    <span>
      {run.surface}{" "}
      <span className="font-mono text-meta text-muted-foreground">{run.locationRef}</span>
    </span>
  );
}

const columns: DataTableColumn<RunSummary>[] = [
  {
    key: "run",
    header: "Run",
    width: "190px",
    render: (run) => <IdChip id={run.id} visibleChars={14} />,
  },
  {
    key: "state",
    header: "State",
    width: "150px",
    render: (run) => <RunStateBadge state={run.state} />,
  },
  {
    key: "trigger",
    header: "Trigger",
    width: "120px",
    render: (run) => triggerLabels[run.trigger],
  },
  {
    key: "source",
    header: "Source",
    render: sourceLabel,
  },
  {
    key: "updated",
    header: "Updated",
    width: "150px",
    render: (run) => <RelativeTime date={run.updatedAt} />,
  },
];

export function RunsPage() {
  const navigate = useNavigate();
  const [state, setState] = useState<RunState | "all">("all");
  const [trigger, setTrigger] = useState<Trigger | "all">("all");
  const runs = useQuery(
    orpc.runs.list.queryOptions({
      input: {
        ...(state === "all" ? {} : { state }),
        ...(trigger === "all" ? {} : { trigger }),
      },
    }),
  );

  return (
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Runs"
        description="Inspect execution history, live activity, approvals, and failures."
      />
      <FilterBar className="mb-3">
        <FilterSelect
          label="State"
          value={state}
          onValueChange={(value) => setState(value as RunState | "all")}
          options={[...stateOptions]}
        />
        <FilterSelect
          label="Trigger"
          value={trigger}
          onValueChange={(value) => setTrigger(value as Trigger | "all")}
          options={[...triggerOptions]}
        />
      </FilterBar>
      {runs.error ? (
        <div className="rounded-md border bg-card">
          <EmptyState
            icon={ScrollText}
            title="Could not load runs"
            description={runs.error.message}
          />
        </div>
      ) : (
        <DataTable
          columns={columns}
          rows={runs.data?.runs ?? []}
          rowKey={(run) => run.id}
          onRowClick={(run) => void navigate(`/runs/${run.id}`)}
          loading={runs.isPending}
          pageSize={25}
          empty={
            <EmptyState
              icon={ScrollText}
              title={state === "all" && trigger === "all" ? "No runs yet" : "No matching runs"}
              description={
                state === "all" && trigger === "all"
                  ? "Runs started from configured integrations, automations, and the API appear here."
                  : "Change the filters to see other runs."
              }
            />
          }
        />
      )}
    </main>
  );
}
