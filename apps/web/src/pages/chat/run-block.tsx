import { useEffect, useMemo, useRef } from "react";
import { ChatBubble } from "#web/components/trema/chat-bubble.tsx";
import { ErrorItem } from "#web/components/trema/error-item.tsx";
import { RunFooter, useElapsed } from "#web/components/trema/run-footer.tsx";
import type { RunState } from "#web/components/trema/run-state-badge.tsx";
import { SegmentDivider } from "#web/components/trema/segment-divider.tsx";
import { UnknownEventsLine } from "#web/components/trema/unknown-events-line.tsx";
import { type RunStreamPhase, useRunStream } from "#web/hooks/use-run-stream.ts";
import {
  isTerminalProjection,
  isTerminalRunState,
  type PrincipalLike,
} from "#web/lib/run-timeline.ts";
import {
  ProjectionSegments,
  projectionChainStreaming,
  projectionHasChain,
  projectionStreamingChainStartedAt,
} from "#web/pages/runs/timeline.tsx";

/** One run on the thread, as the thread-runs read (or a placeholder) has it. */
export interface ThreadRun {
  id: string;
  state: RunState;
  trigger: string;
  createdAt: string;
  openingMessage: { author: PrincipalLike; text: string } | null;
  /** The opening send's intent id — placeholder runs only; reads omit it. */
  openingIntentId?: string;
}

/** What a run block's tail knows that the thread screen acts on. */
export interface RunBlockFacts {
  phase: RunStreamPhase;
  /** Whether the run has settled by either signal — header state or tail. */
  settled: boolean;
  /** Every steering text the projection carries, in order. */
  steeringTexts: readonly string[];
}

function factsEqual(a: RunBlockFacts | undefined, b: RunBlockFacts): boolean {
  return (
    a !== undefined &&
    a.phase === b.phase &&
    a.settled === b.settled &&
    a.steeringTexts.length === b.steeringTexts.length &&
    a.steeringTexts.every((text, index) => text === b.steeringTexts[index])
  );
}

/**
 * One run in the thread: the opening user message as a right-aligned bubble,
 * the folded projection rendered with the run view's own part vocabulary,
 * and a footer whose worked-for duration is the deep link to the canonical
 * run view. Historical runs fold their paged history once and stay static;
 * an active run tails its stream — both through the same hook, so a mid-run
 * reload shows byte-identical history here exactly as on the run view.
 */
export function RunBlock({
  run,
  onFacts,
}: {
  run: ThreadRun;
  /** Reported upward so the thread screen can steer, morph, and refetch. */
  onFacts?: (runId: string, facts: RunBlockFacts) => void;
}) {
  const stream = useRunStream(run.id, run.state);
  const { projection, meta, phase } = stream;
  // Either signal settles the run: the header read can be ahead of the tail
  // (a stale run with no terminal event) and the tail ahead of the header.
  const settled =
    isTerminalRunState(run.state) || phase === "static" || isTerminalProjection(projection.status);

  // The opening message IS the first steering event on the log (the loop
  // drains the trigger there — history.ts derives it by the same rule), and
  // this screen already renders it as the user bubble. Suppress that one part
  // so it never reads twice; the run view, which has no bubble, keeps it.
  const displayProjection = useMemo(() => {
    const opening = run.openingMessage;
    const first = projection.segments[0]?.parts[0];
    if (
      opening === null ||
      first === undefined ||
      first.kind !== "steering" ||
      first.text !== opening.text ||
      first.author.principalId !== opening.author.principalId
    ) {
      return projection;
    }
    const segments = projection.segments.map((segment, index) =>
      index === 0 ? { ...segment, parts: segment.parts.slice(1) } : segment,
    );
    return { ...projection, segments };
  }, [projection, run.openingMessage]);

  // Counted from the display projection, not the raw one: the thread's
  // pending-steer reconciliation matches against these, and the opening
  // part — a steer only to the log — must not count as one landing.
  const steeringTexts = useMemo(
    () =>
      displayProjection.segments.flatMap((segment) =>
        segment.parts.flatMap((part) => (part.kind === "steering" ? [part.text] : [])),
      ),
    [displayProjection],
  );

  const lastFacts = useRef<RunBlockFacts | undefined>(undefined);
  useEffect(() => {
    const facts: RunBlockFacts = { phase, settled, steeringTexts };
    if (factsEqual(lastFacts.current, facts)) return;
    lastFacts.current = facts;
    onFacts?.(run.id, facts);
  }, [run.id, phase, settled, steeringTexts, onFacts]);

  const cancelled = run.state === "cancelled" || projection.status === "cancelled";
  const failed = run.state === "failed" || projection.status === "failed";
  const hasErrorPart = projection.segments.some((segment) =>
    segment.parts.some((part) => part.kind === "error"),
  );
  const lastPart = displayProjection.segments.at(-1)?.parts.at(-1);
  const thinking =
    phase === "live" &&
    !settled &&
    (lastPart === undefined ||
      lastPart.kind === "steering" ||
      (lastPart.kind === "text" && lastPart.status === "done"));

  // Machinery chains derive their settled duration from their own part-event
  // range. A run without a chain keeps the run-level duration on the footer.
  const hasChain = projectionHasChain(displayProjection);
  const copyText = useMemo(
    () =>
      displayProjection.segments
        .flatMap((segment) =>
          segment.parts.flatMap((part) => (part.kind === "text" ? [part.markdown] : [])),
        )
        .filter((text) => text.length > 0)
        .join("\n\n"),
    [displayProjection],
  );

  // While a chain is streaming, its trigger is the run's one live line: it
  // carries a timer anchored to that burst's first event and the footer stays
  // silent until the run settles. Stopping lives on the composer.
  const chainStreaming = !settled && projectionChainStreaming(displayProjection);
  const chainStartedAt =
    projectionStreamingChainStartedAt(displayProjection, meta) ?? run.createdAt;
  const elapsed = useElapsed(chainStartedAt, chainStreaming);

  return (
    <div
      data-slot="run-block"
      className="group/run animate-in space-y-6 fade-in slide-in-from-bottom-1 duration-150 motion-reduce:animate-none"
    >
      {run.openingMessage !== null && <ChatBubble>{run.openingMessage.text}</ChatBubble>}
      <div className="space-y-3">
        {phase === "error" && (
          <ErrorItem
            title="Could not load this run"
            message={stream.error ?? "The event read failed."}
          />
        )}
        {phase === "loading" && projection.segments.length === 0 && (
          <div className="h-5 w-1/3 animate-pulse rounded-sm bg-muted/40" />
        )}
        <ProjectionSegments
          runId={run.id}
          runCreatedAt={run.createdAt}
          projection={displayProjection}
          meta={meta}
          resolvable={!settled}
          expandOutputs={false}
          collapseChain
          partVocabulary="chat"
          {...(chainStreaming ? { chainWorkingFor: elapsed } : {})}
        />
        {thinking && (
          <span
            data-slot="chat-thinking"
            className="inline-block py-1.5 text-sm leading-none text-muted-foreground shimmer motion-reduce:animate-none"
          >
            Thinking
          </span>
        )}
        {/* A stop is a recorded decision, not a failure: it reads as a quiet
            boundary. A failed run without an error part in its log still states
            the failure — the run view carries the full record. */}
        {cancelled && <SegmentDivider reason="stopped" />}
        {failed && !hasErrorPart && (
          <ErrorItem title="Run failed" message="The run ended in an error. See the run view." />
        )}
        {phase !== "error" && !chainStreaming && !thinking && (
          <RunFooter
            runId={run.id}
            startedAt={run.createdAt}
            {...(meta.lastAt === undefined || hasChain ? {} : { endedAt: meta.lastAt })}
            live={!settled}
            {...(settled && copyText ? { copyText } : {})}
            {...(settled
              ? {
                  className:
                    "pointer-events-none opacity-0 transition-opacity duration-150 group-hover/run:pointer-events-auto group-hover/run:opacity-100 group-focus-within/run:pointer-events-auto group-focus-within/run:opacity-100",
                }
              : {})}
          />
        )}
        <UnknownEventsLine count={projection.unknownEvents + stream.serverMalformed} />
      </div>
    </div>
  );
}
