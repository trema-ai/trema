import { useQuery } from "@tanstack/react-query";
import { ScrollText } from "lucide-react";
import { useState } from "react";
import { Link, useParams } from "react-router";

import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { ErrorItem } from "#web/components/trema/error-item.tsx";
import { IdChip } from "#web/components/trema/id-chip.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { RunStateBadge } from "#web/components/trema/run-state-badge.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Tabs, TabsList, TabsTrigger } from "#web/components/ui/tabs.tsx";
import { useRunStream } from "#web/hooks/use-run-stream.ts";
import { orpc, type rpcClient } from "#web/lib/api.ts";
import { isTerminalRunState, parseUsage } from "#web/lib/run-timeline.ts";
import { cn } from "#web/lib/utils.ts";
import { GrantSnapshotPanel, Panel, ThreadPanel, UsagePanel } from "#web/pages/runs/panels.tsx";
import { RunTimeline } from "#web/pages/runs/timeline.tsx";

type RunRead = Awaited<ReturnType<typeof rpcClient.runs.get>>;
type FullRun = Extract<RunRead, { access: "full" }>;
type MetadataRun = Extract<RunRead, { access: "metadata" }>;

const triggerPhrase: Record<RunRead["trigger"], string> = {
  message: "a message",
  api: "the API",
  schedule: "a schedule",
  retry: "a retry",
  resume: "a resume",
};

/** The canonical run view: everything the log knows about one run. */
export function RunPage() {
  const { id = "" } = useParams();
  const runQuery = useQuery(orpc.runs.get.queryOptions({ input: { id } }));

  if (runQuery.isPending) {
    return (
      <main className="mx-auto w-full max-w-[1240px] space-y-4 p-4 sm:p-6 lg:p-8">
        <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
        {[1, 2, 3].map((key) => (
          <div key={key} className="h-24 animate-pulse rounded-lg border bg-muted/30" />
        ))}
      </main>
    );
  }
  if (runQuery.error) {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={ScrollText}
          title="Could not load this run"
          description={runQuery.error.message}
        />
      </main>
    );
  }
  const run = runQuery.data;
  if (run.access === "metadata") return <MetadataRunView run={run} />;
  // Keyed so navigating between runs remounts the stream from scratch.
  return <FullRunView key={run.id} run={run} />;
}

/** The connector and location, said plainly; the web location is just "Web". */
function sourceLabel(run: FullRun) {
  if (run.surface === "web") return "Web";
  return (
    <>
      {run.surface} <span className="font-mono">{run.locationRef}</span>
    </>
  );
}

function FullRunView({ run }: { run: FullRun }) {
  const stream = useRunStream(run.id, run.state);
  const [tab, setTab] = useState<"timeline" | "details">("timeline");
  const terminal = isTerminalRunState(run.state);
  // The run read's totals are authoritative once present; the projection's
  // usage covers the moment the tail has seen `run-finished` first.
  const usage = parseUsage(run.usage) ?? parseUsage(stream.projection.usage);

  const panels = (
    <>
      <GrantSnapshotPanel grantSnapshot={run.grantSnapshot} />
      <UsagePanel usage={usage} turnCount={run.turnCount} settled={terminal} />
      <ThreadPanel runId={run.id} threadRef={run.threadRef} />
      {(run.retryOfRunId !== null || run.error !== null) && (
        <Panel title="Lineage">
          <div className="space-y-2 text-meta">
            {run.retryOfRunId !== null && (
              <p>
                Retry
                {run.retryAttempt !== null && <> attempt {run.retryAttempt}</>} of{" "}
                <Link to={`/runs/${run.retryOfRunId}`} className="text-moss hover:underline">
                  <span className="font-mono">{run.retryOfRunId.slice(0, 8)}…</span>
                </Link>
              </p>
            )}
            {run.error !== null && (
              <p className="font-mono break-all text-destructive">{run.error}</p>
            )}
          </div>
        </Panel>
      )}
    </>
  );

  return (
    <main className="mx-auto w-full max-w-[1240px] p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            Run
            <IdChip id={run.id} visibleChars={14} />
          </span>
        }
        description={
          <>
            Started by {triggerPhrase[run.trigger]} · {sourceLabel(run)} · created{" "}
            <RelativeTime date={run.createdAt} /> · updated <RelativeTime date={run.updatedAt} />
          </>
        }
        actions={
          <div className="flex flex-col items-end gap-1">
            <div className="flex items-center gap-3">
              <RunStateBadge state={run.state} />
              {/* Read-only for now: stop and retry are intents this page does
                  not yet send, so the buttons state that instead of hiding. */}
              <Button size="sm" variant="outline" disabled>
                {terminal ? "Retry" : "Stop"}
              </Button>
            </div>
            <span className="text-meta text-muted-foreground">
              Run controls from the web are not yet available.
            </span>
          </div>
        }
      />
      {run.error !== null && <ErrorItem className="mb-4" title="Run failed" message={run.error} />}
      <Tabs
        value={tab}
        onValueChange={(value) => setTab(value === "details" ? "details" : "timeline")}
        className="mb-4 min-[1200px]:hidden"
      >
        <TabsList>
          <TabsTrigger value="timeline">Timeline</TabsTrigger>
          <TabsTrigger value="details">Details</TabsTrigger>
        </TabsList>
      </Tabs>
      <div className="flex items-start gap-8">
        {/* The timeline stays mounted while the details tab covers it, so
            expanded outputs and the live tail survive tab flips. */}
        <div
          className={cn(
            "min-w-0 max-w-215 flex-1",
            tab === "details" && "hidden min-[1200px]:block",
          )}
        >
          <RunTimeline
            runId={run.id}
            runCreatedAt={run.createdAt}
            snapshot={stream}
            queuedInput={run.queuedInput}
          />
        </div>
        {tab === "details" && (
          <div className="min-w-0 flex-1 space-y-6 min-[1200px]:hidden">{panels}</div>
        )}
        <aside className="hidden w-80 shrink-0 space-y-6 min-[1200px]:block">{panels}</aside>
      </div>
    </main>
  );
}

/**
 * The audit view: an org admin looking at a run in another person's personal
 * scope sees that it happened and what it touched, never its content.
 */
function MetadataRunView({ run }: { run: MetadataRun }) {
  const usage = parseUsage(run.usage);
  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title={
          <span className="flex items-center gap-2.5">
            Run
            <IdChip id={run.id} visibleChars={14} />
          </span>
        }
        description={
          <>
            Started by {triggerPhrase[run.trigger]} · created <RelativeTime date={run.createdAt} />{" "}
            · updated <RelativeTime date={run.updatedAt} />
          </>
        }
        actions={<RunStateBadge state={run.state} />}
      />
      <p className="mb-6 text-chrome text-muted-foreground">
        This run belongs to another person's personal scope. You can see that it ran and which tools
        it called, not what it did.
      </p>
      <div className="grid items-start gap-6 sm:grid-cols-2">
        <UsagePanel
          usage={usage}
          turnCount={run.turnCount}
          settled={isTerminalRunState(run.state)}
        />
        <Panel title="Tools called">
          {run.toolNames.length === 0 ? (
            <p className="text-meta text-muted-foreground">No tool calls recorded.</p>
          ) : (
            <ul className="space-y-1">
              {run.toolNames.map((name) => (
                <li key={name} className="font-mono text-meta break-all">
                  {name}
                </li>
              ))}
            </ul>
          )}
        </Panel>
      </div>
    </main>
  );
}
