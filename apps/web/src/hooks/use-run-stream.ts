import { useQueryClient } from "@tanstack/react-query";
import { advance, type FoldInput, fold, type Projection } from "@trema/projection";
import { useEffect, useRef, useState } from "react";

import type { RunState } from "#web/components/trema/run-state-badge.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import {
  advanceTimelineMeta,
  emptyTimelineMeta,
  isTerminalProjection,
  isTerminalRunState,
  parseEventFrame,
  parseMalformedFrame,
  type TimelineMeta,
} from "#web/lib/run-timeline.ts";

/**
 * Where the timeline read currently is:
 * - `loading` — paging through history; the projection grows as pages land.
 * - `live` — history is folded and the SSE tail is advancing it.
 * - `static` — the run is settled (or was terminal on load); no tail.
 * - `error` — the initial history read failed outright.
 */
export type RunStreamPhase = "loading" | "live" | "static" | "error";

export interface RunStreamSnapshot {
  phase: RunStreamPhase;
  projection: Projection;
  meta: TimelineMeta;
  /** Rows the server skipped as malformed, on pages and on the stream. */
  serverMalformed: number;
  error?: string;
}

/** The largest page the events read serves; history loads at full stride. */
const HISTORY_PAGE_SIZE = 1000;

/**
 * Folds a run's timeline from the paged events read, then keeps it moving
 * over SSE while the run is live.
 *
 * Everything renders from persisted rows — nothing optimistic — so a mid-run
 * refresh shows byte-identical history. On stream errors the paged read is
 * refetched from the fold's cursor (re-delivered rows dedupe by seq), which
 * covers reconnect gaps of any size. When the projection turns terminal the
 * stream closes, the phase drops to `static`, and the run read is invalidated
 * once so header state and usage settle.
 */
export function useRunStream(runId: string, runState: RunState): RunStreamSnapshot {
  const [snapshot, setSnapshot] = useState<RunStreamSnapshot>(() => ({
    phase: "loading",
    projection: fold(runId, []),
    meta: emptyTimelineMeta(),
    serverMalformed: 0,
  }));
  // The latest header state, readable without retriggering the effect: a
  // refetch flipping `running` to `completed` must not tear down and refold.
  const runStateRef = useRef(runState);
  runStateRef.current = runState;
  const queryClient = useQueryClient();

  useEffect(() => {
    let cancelled = false;
    let source: EventSource | undefined;
    let reconciling = false;
    const store = {
      projection: fold(runId, []),
      meta: emptyTimelineMeta(),
      malformed: 0,
    };
    setSnapshot({
      phase: "loading",
      projection: store.projection,
      meta: store.meta,
      serverMalformed: 0,
    });

    const publish = (phase: RunStreamPhase, error?: string) => {
      if (cancelled) return;
      setSnapshot({
        phase,
        projection: store.projection,
        meta: store.meta,
        serverMalformed: store.malformed,
        ...(error === undefined ? {} : { error }),
      });
    };

    // Header state and usage live on the run read; a lifecycle transition
    // seen on the log is the cue to refetch it.
    const settleHeader = () => {
      void queryClient.invalidateQueries({ queryKey: orpc.runs.get.key() });
    };

    const closeStream = () => {
      source?.close();
      source = undefined;
    };

    const apply = (inputs: readonly FoldInput[], malformed: number) => {
      const before = store.projection.status;
      store.projection = advance(store.projection, inputs);
      store.meta = advanceTimelineMeta(store.meta, inputs);
      store.malformed += malformed;
      const after = store.projection.status;
      if (source !== undefined) {
        // Pauses and resolutions land on the tail before the header notices;
        // terminal events end the tail outright.
        if (after !== before && (after === "paused" || isTerminalProjection(after))) {
          settleHeader();
        }
        if (isTerminalProjection(after)) {
          closeStream();
          publish("static");
          return;
        }
      }
      publish(source === undefined ? "loading" : "live");
    };

    const loadPages = async (after: number): Promise<void> => {
      let cursor = after;
      for (;;) {
        const page = await rpcClient.runs.events({
          id: runId,
          after: cursor,
          limit: HISTORY_PAGE_SIZE,
        });
        if (cancelled) return;
        apply(page.events, page.malformed);
        cursor = page.cursor;
        if (!page.hasMore) return;
      }
    };

    const openStream = () => {
      const stream = new EventSource(
        `/api/v1/runs/${encodeURIComponent(runId)}/stream?after=${store.projection.lastSeq}`,
        { withCredentials: true },
      );
      source = stream;
      stream.onmessage = (event) => {
        if (cancelled || source !== stream) return;
        const frame = parseEventFrame(event.data);
        if (frame === null) {
          // An unreadable frame has no seq to advance past; the next
          // reconnect's paged refetch reconciles it. Count it meanwhile.
          store.malformed += 1;
          publish("live");
          return;
        }
        apply([frame], 0);
      };
      stream.addEventListener("run-event-malformed", (event) => {
        if (cancelled || source !== stream) return;
        const seq = parseMalformedFrame((event as MessageEvent<unknown>).data);
        store.malformed += 1;
        // Advance the cursor past the bad row so a reconnect never replays it.
        if (seq !== null && seq > store.projection.lastSeq) {
          store.projection = { ...store.projection, lastSeq: seq };
        }
        publish("live");
      });
      stream.onerror = () => {
        if (cancelled || source !== stream) return;
        // The server closes the stream once the run settles. Without a
        // terminal event on the log (a stale run) the browser would retry
        // forever, so a terminal header state also ends the tail here.
        if (
          isTerminalProjection(store.projection.status) ||
          isTerminalRunState(runStateRef.current)
        ) {
          closeStream();
          settleHeader();
          publish("static");
          return;
        }
        // The browser is reconnecting on its own; the paged read covers
        // whatever the gap swallowed, deduped by seq. Single flight — error
        // events can repeat faster than pages return.
        if (reconciling) return;
        reconciling = true;
        void loadPages(store.projection.lastSeq)
          .catch(() => undefined)
          .finally(() => {
            reconciling = false;
          });
        settleHeader();
      };
      publish("live");
    };

    void (async () => {
      try {
        await loadPages(0);
      } catch (error) {
        publish("error", error instanceof Error ? error.message : "The event read failed");
        return;
      }
      if (cancelled) return;
      if (
        isTerminalProjection(store.projection.status) ||
        isTerminalRunState(runStateRef.current)
      ) {
        publish("static");
        return;
      }
      openStream();
    })();

    return () => {
      cancelled = true;
      closeStream();
    };
  }, [runId, queryClient]);

  return snapshot;
}
