import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Link } from "react-router";

import { IdChip } from "#web/components/trema/id-chip.tsx";
import { type KeyValueItem, KeyValueList } from "#web/components/trema/key-value-list.tsx";
import { orpc } from "#web/lib/api.ts";
import type { RunUsage } from "#web/lib/run-timeline.ts";

/** Section label above a flat bordered card, per the settings grammar. */
export function Panel({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section data-slot="run-panel">
      <h2 className="mb-2 text-chrome font-medium">{title}</h2>
      <div className="rounded-md border bg-card p-3">{children}</div>
    </section>
  );
}

/**
 * The pinned resolution stored on the run: what the agent was allowed, next
 * to the timeline's record of what it did.
 */
export function GrantSnapshotPanel({
  grantSnapshot,
}: {
  grantSnapshot: { scopeChain: string[]; snapshotHash: string };
}) {
  return (
    <Panel title="Grant snapshot">
      <KeyValueList
        items={[
          {
            label: "Scope chain",
            value:
              grantSnapshot.scopeChain.length === 0 ? (
                <span className="text-muted-foreground">none</span>
              ) : (
                <div className="space-y-1">
                  {grantSnapshot.scopeChain.map((scopeId) => (
                    <div key={scopeId} className="break-all">
                      {scopeId}
                    </div>
                  ))}
                </div>
              ),
            mono: true,
          },
          {
            label: "Snapshot hash",
            value: <span className="break-all">{grantSnapshot.snapshotHash}</span>,
            mono: true,
          },
        ]}
      />
    </Panel>
  );
}

function formatTokens(count: number): string {
  return count.toLocaleString();
}

export function UsagePanel({
  usage,
  turnCount,
  settled,
}: {
  usage: RunUsage | null;
  turnCount: number;
  /** Whether the run is terminal; a live run's numbers are partials. */
  settled: boolean;
}) {
  const items: KeyValueItem[] = [{ label: "Turns", value: String(turnCount), mono: true }];
  if (usage !== null) {
    if (usage.inputTokens !== undefined)
      items.push({ label: "Input tokens", value: formatTokens(usage.inputTokens), mono: true });
    if (usage.outputTokens !== undefined)
      items.push({ label: "Output tokens", value: formatTokens(usage.outputTokens), mono: true });
    if (usage.totalTokens !== undefined)
      items.push({ label: "Total tokens", value: formatTokens(usage.totalTokens), mono: true });
    if (usage.cacheReadTokens !== undefined)
      items.push({ label: "Cache read", value: formatTokens(usage.cacheReadTokens), mono: true });
    if (usage.cacheWriteTokens !== undefined)
      items.push({ label: "Cache write", value: formatTokens(usage.cacheWriteTokens), mono: true });
    if (usage.costUsd !== undefined)
      items.push({ label: "Cost", value: `$${usage.costUsd.toFixed(4)}`, mono: true });
  }
  return (
    <Panel title="Usage">
      <KeyValueList items={items} />
      {usage === null && (
        <p className="mt-2 text-meta text-muted-foreground">
          {settled ? "No usage was reported." : "No usage reported yet."}
        </p>
      )}
      {usage !== null && !settled && (
        <p className="mt-2 text-meta text-muted-foreground">Partial totals; the run is live.</p>
      )}
    </Panel>
  );
}

/**
 * Where this run sits on its thread, with prev/next hops: a conversation is
 * usually many runs, and debugging follows the thread.
 */
export function ThreadPanel({ runId, threadRef }: { runId: string; threadRef: string }) {
  const query = useQuery(orpc.runs.listByThread.queryOptions({ input: { threadRef } }));
  const runs = query.data?.runs ?? [];
  const position = runs.findIndex((run) => run.id === runId);
  const previous = position > 0 ? runs[position - 1] : undefined;
  const next = position >= 0 ? runs[position + 1] : undefined;
  return (
    <Panel title="Thread">
      <KeyValueList items={[{ label: "Thread", value: <IdChip id={threadRef} /> }]} />
      {position >= 0 && (
        <p className="mt-2 text-meta text-muted-foreground">
          Run {position + 1} of {runs.length} on this thread
        </p>
      )}
      <div className="mt-2 flex items-center justify-between gap-3 text-meta">
        {previous === undefined ? (
          <span className="text-muted-foreground">← Previous run</span>
        ) : (
          <Link to={`/runs/${previous.id}`} className="text-moss hover:underline">
            ← Previous run
          </Link>
        )}
        {next === undefined ? (
          <span className="text-muted-foreground">Next run →</span>
        ) : (
          <Link to={`/runs/${next.id}`} className="text-moss hover:underline">
            Next run →
          </Link>
        )}
      </div>
    </Panel>
  );
}
