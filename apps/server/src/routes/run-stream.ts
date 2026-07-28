import { parseRunEvent } from "@trema/harness";
import type { Context } from "hono";
import { streamSSE } from "hono/streaming";

import type { RunState } from "#server/generated/prisma/client.js";
import type { Auth } from "#server/lib/auth/index.js";
import { resolveOrgPrincipal } from "#server/lib/auth/org-principal.js";
import type { Database } from "#server/lib/db/index.js";
import { bindLogger, log } from "#server/lib/logger/index.js";
import { resolveRunAccess } from "#server/services/runs/index.js";

/** How often the tail re-checks `lastEventSeq` while the log is quiet. */
const DEFAULT_POLL_INTERVAL_MS = 750;
/** How often an idle stream writes a comment so proxies keep it open. */
const DEFAULT_HEARTBEAT_INTERVAL_MS = 15_000;

/** States a run never leaves; once the cursor catches up, no more events come. */
const TERMINAL_RUN_STATES: ReadonlySet<RunState> = new Set([
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

/** Timing knobs, injectable so tests never sleep real seconds. */
export interface RunStreamTiming {
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
}

export interface RunStreamDependencies extends RunStreamTiming {
  db: Database;
  auth: Auth;
}

/** A non-negative integer cursor, or null for anything else. */
function parseCursor(value: string | undefined): number | null {
  if (value === undefined || value === "") return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

/** Resolves after `ms`, or immediately on abort — the timer never outlives the stream. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * `GET /api/v1/runs/{id}/stream` — the SSE tail over a run's persisted log.
 *
 * A long-lived streaming read does not fit the oRPC mold, so this is a raw
 * Hono route beside the JSON reads. It re-emits `RunEvent` rows from a cursor
 * — `Last-Event-ID` on reconnect, `?after=` on first attach, else the start —
 * with `id:` carrying the seq and `data:` carrying the same `{seq, at, event}`
 * envelope the paged events read returns. It reads persisted rows on a short
 * single-flight poll keyed to `AgentRun.lastEventSeq`, never the model stream;
 * `LISTEN/NOTIFY` is a later drop-in behind this same route.
 *
 * Access follows the one run-access rule: only a `full` viewer streams, and
 * `metadata`, `none`, and a missing run all get the same 404 before any SSE
 * headers — a distinct refusal would disclose that the run exists.
 *
 * The stream closes after emitting a `run-finished` event, or once the run's
 * state is terminal and the cursor has caught up (a `stale` run may have no
 * `run-finished` event). While idle it writes a `: ping` comment so proxies
 * keep the connection open, and a client disconnect aborts the poll loop
 * promptly — no timer outlives the request.
 */
export function createRunStreamHandler(dependencies: RunStreamDependencies) {
  const { db, auth } = dependencies;
  const pollIntervalMs = dependencies.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const heartbeatIntervalMs = dependencies.heartbeatIntervalMs ?? DEFAULT_HEARTBEAT_INTERVAL_MS;

  return async (context: Context) => {
    const session = await auth.api.getSession({ headers: context.req.raw.headers });
    if (!session) {
      log.warn("Authentication required");
      return context.json({ error: "Authentication required" }, 401);
    }
    bindLogger({ userId: session.user.id });

    const resolved = await resolveOrgPrincipal(db, session);
    if (!resolved.ok) {
      return context.json({ error: resolved.message }, 403);
    }
    const { org, principal } = resolved;

    // The route pattern guarantees the param; the guard narrows the type and
    // folds a degenerate path onto the one refusal.
    const runId = context.req.param("id");
    if (!runId) {
      return context.json({ error: "Run not found" }, 404);
    }
    const verdict = await resolveRunAccess({ db, orgId: org.id, principal, runId });
    // The one refusal for a run the caller may not stream, byte-identical to a
    // run that does not exist (see `resolveRunAccess`).
    if (verdict.access !== "full") {
      return context.json({ error: "Run not found" }, 404);
    }

    // Last-Event-ID is the browser's reconnect cursor and wins over the
    // first-attach query param.
    const initialCursor =
      parseCursor(context.req.header("last-event-id")) ??
      parseCursor(context.req.query("after")) ??
      0;

    // Reverse proxies buffer by default, which would hold events back.
    context.header("X-Accel-Buffering", "no");

    return streamSSE(context, async (stream) => {
      // One signal for the whole loop: the response stream being cancelled
      // (client disconnect) and the request itself aborting both land here.
      const abort = new AbortController();
      stream.onAbort(() => abort.abort());
      const requestSignal = context.req.raw.signal;
      const onRequestAbort = () => abort.abort();
      requestSignal.addEventListener("abort", onRequestAbort, { once: true });
      if (requestSignal.aborted) abort.abort();

      try {
        let cursor = initialCursor;
        let lastWriteAt = Date.now();

        // Single-flight by construction: one sequential loop, so a slow fetch
        // delays the next poll rather than overlapping it.
        while (!abort.signal.aborted) {
          const run = await db.agentRun.findUnique({
            where: { orgId_id: { orgId: org.id, id: runId } },
            select: { state: true, lastEventSeq: true },
          });
          // A run deleted mid-stream has nothing further to say.
          if (!run) return;

          // The indexed `lastEventSeq` read answers "anything new?" without
          // touching RunEvent; rows are fetched only when it moved.
          if (run.lastEventSeq > cursor) {
            const rows = await db.runEvent.findMany({
              where: { orgId: org.id, runId, seq: { gt: cursor } },
              orderBy: { seq: "asc" },
              select: { seq: true, at: true, v: true, event: true },
            });

            for (const row of rows) {
              if (abort.signal.aborted) return;
              cursor = row.seq;
              let parsed;
              try {
                parsed = parseRunEvent({
                  runId,
                  seq: row.seq,
                  at: row.at.toISOString(),
                  v: row.v,
                  event: row.event,
                });
              } catch {
                // Aligned with the paged read: a malformed known event is
                // skipped and the cursor still advances past it. The comment
                // keeps reconnecting clients' Last-Event-ID moving too.
                await stream.write(`: malformed event ${row.seq} skipped\n\n`);
                lastWriteAt = Date.now();
                continue;
              }
              await stream.writeSSE({
                id: String(row.seq),
                data: JSON.stringify({
                  seq: row.seq,
                  at: row.at.toISOString(),
                  event: parsed.value.event,
                }),
              });
              lastWriteAt = Date.now();
              if (parsed.value.event.type === "run-finished") return;
            }
          }

          // A terminal run with no run-finished event (a `stale` run, an
          // anomaly) still closes once the log is drained.
          if (TERMINAL_RUN_STATES.has(run.state) && cursor >= run.lastEventSeq) return;

          if (Date.now() - lastWriteAt >= heartbeatIntervalMs) {
            await stream.write(": ping\n\n");
            lastWriteAt = Date.now();
          }

          await sleep(pollIntervalMs, abort.signal);
        }
      } finally {
        requestSignal.removeEventListener("abort", onRequestAbort);
        abort.abort();
      }
    });
  };
}
