import { useQuery } from "@tanstack/react-query";
import type {
  ActivityPart,
  DataPart,
  ElicitationPart,
  Part,
  SteeringPart,
} from "@trema/projection";
import { ChevronRight, ScrollText } from "lucide-react";
import { Fragment } from "react";

import { ActivityCard, type ActivityState } from "#web/components/trema/activity-card.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { ErrorItem } from "#web/components/trema/error-item.tsx";
import { OutputViewer } from "#web/components/trema/output-viewer.tsx";
import { ReasoningBlock } from "#web/components/trema/reasoning-block.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
import { SegmentDivider } from "#web/components/trema/segment-divider.tsx";
import { StatusDot } from "#web/components/trema/status-dot.tsx";
import { SteeringNote } from "#web/components/trema/steering-note.tsx";
import { UnknownEventsLine } from "#web/components/trema/unknown-events-line.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#web/components/ui/collapsible.tsx";
import type { RunStreamSnapshot } from "#web/hooks/use-run-stream.ts";
import { orpc } from "#web/lib/api.ts";
import {
  type PrincipalLike,
  parkDetail,
  principalLabel,
  steeringSeq,
  type TimelineMeta,
} from "#web/lib/run-timeline.ts";
import { cn } from "#web/lib/utils.ts";

/** One undrained steer or follow-up, as the run read reports it. */
export interface QueuedInputItem {
  id: string;
  kind: "steering" | "follow_up";
  text: string;
  author: PrincipalLike;
  position: number;
  queuedAt: string;
}

export function RunTimeline({
  runId,
  runCreatedAt,
  snapshot,
  queuedInput,
}: {
  runId: string;
  runCreatedAt: string;
  snapshot: RunStreamSnapshot;
  queuedInput: QueuedInputItem[];
}) {
  const { projection, meta, phase } = snapshot;

  if (phase === "error") {
    return (
      <ErrorItem
        title="Could not load the timeline"
        message={snapshot.error ?? "The event read failed."}
      />
    );
  }
  if (phase === "loading" && projection.segments.length === 0) {
    return (
      <div className="space-y-3">
        {[1, 2, 3].map((key) => (
          <div key={key} className="h-5 animate-pulse rounded-sm bg-muted/40" />
        ))}
      </div>
    );
  }

  // Boundary times live beside the fold, one record per closed segment in
  // order; pairing them up front keeps the render pass free of counters.
  const dividerDetail = new Map<number, string>();
  let closed = 0;
  for (const segment of projection.segments) {
    if (segment.end === undefined) continue;
    if (segment.end.reason === "paused") {
      const detail = parkDetail(meta.boundaries[closed]);
      if (detail !== undefined) dividerDetail.set(segment.index, detail);
    }
    closed += 1;
  }

  const unknownCount = projection.unknownEvents + snapshot.serverMalformed;

  return (
    <div className="space-y-3">
      {projection.segments.length === 0 && (
        <EmptyState
          icon={ScrollText}
          title="No events yet"
          description="The run has not recorded anything so far."
        />
      )}
      {projection.segments.map((segment) => {
        const detail = dividerDetail.get(segment.index);
        return (
          <Fragment key={segment.index}>
            {chunkParts(segment.parts).map((chunk) =>
              chunk.kind === "machinery" ? (
                <div key={chunk.key} className="space-y-0.5">
                  {chunk.parts.map((part) => (
                    <TimelinePart
                      key={`${part.kind}:${part.id}`}
                      runId={runId}
                      runCreatedAt={runCreatedAt}
                      part={part}
                      meta={meta}
                    />
                  ))}
                </div>
              ) : (
                <TimelinePart
                  key={`${chunk.part.kind}:${chunk.part.id}`}
                  runId={runId}
                  runCreatedAt={runCreatedAt}
                  part={chunk.part}
                  meta={meta}
                />
              ),
            )}
            {segment.end !== undefined && (
              <SegmentDivider
                reason={segment.end.reason}
                {...(detail === undefined ? {} : { detail })}
              />
            )}
          </Fragment>
        );
      })}
      {queuedInput.map((item) => (
        <QueuedInputNote key={item.id} item={item} />
      ))}
      {phase === "live" && (
        <div className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <StatusDot tone="run" />
          Live
        </div>
      )}
      <UnknownEventsLine count={unknownCount} />
    </div>
  );
}

/**
 * The hierarchy of the timeline: conversation (steering, text, elicitations)
 * reads at full contrast with room around it; machinery (tools, reasoning,
 * data, errors) is muted and consecutive rows stack tight, so a burst of
 * activity reads as one recessed group between the words.
 */
type PartChunk =
  | { kind: "prose"; part: Part; key: string }
  | { kind: "machinery"; parts: Part[]; key: string };

function chunkParts(parts: readonly Part[]): PartChunk[] {
  const machinery = new Set<Part["kind"]>([
    "activity",
    "reasoning",
    "data",
    "error",
    "elicitation",
  ]);
  const chunks: PartChunk[] = [];
  for (const part of parts) {
    const last = chunks[chunks.length - 1];
    if (!machinery.has(part.kind)) {
      chunks.push({ kind: "prose", part, key: `${part.kind}:${part.id}` });
    } else if (last !== undefined && last.kind === "machinery") {
      last.parts.push(part);
    } else {
      chunks.push({ kind: "machinery", parts: [part], key: `${part.kind}:${part.id}` });
    }
  }
  return chunks;
}

function TimelinePart({
  runId,
  runCreatedAt,
  part,
  meta,
}: {
  runId: string;
  runCreatedAt: string;
  part: Part;
  meta: TimelineMeta;
}) {
  switch (part.kind) {
    case "text":
      return (
        <div className="text-chat leading-relaxed break-words whitespace-pre-wrap">
          {part.markdown}
        </div>
      );
    case "reasoning":
      return (
        <ReasoningBlock redacted={part.redacted === true}>
          <span className="whitespace-pre-wrap">{part.text}</span>
        </ReasoningBlock>
      );
    case "activity":
      return <ActivityView runId={runId} part={part} />;
    case "steering":
      return <SteeringView part={part} meta={meta} runCreatedAt={runCreatedAt} />;
    case "elicitation":
      return <ElicitationView part={part} />;
    case "error":
      return (
        <ErrorItem
          title={part.recoverable ? "Recoverable error" : "Error"}
          message={part.message}
        />
      );
    case "data":
      return <DataPartView part={part} />;
  }
}

function ActivityView({ runId, part }: { runId: string; part: ActivityPart }) {
  const state: ActivityState | undefined =
    part.result !== undefined
      ? part.result.status === "ok"
        ? "ok"
        : part.result.status
      : part.status === "streaming"
        ? "running"
        : undefined;
  const outputRef = part.result?.outputRef;
  return (
    <ActivityCard
      title={part.title}
      kind={part.name}
      {...(part.input === undefined ? {} : { input: part.input })}
      {...(part.notes.length === 0 ? {} : { notes: part.notes.join(" · ") })}
      {...(part.result === undefined ? {} : { resultSummary: part.result.summary })}
      {...(state === undefined ? {} : { state })}
    >
      {/* Mounted on first expand only: the collapsible unmounts closed
          content, so the output read is lazy by construction. */}
      {outputRef === undefined ? undefined : <LazyOutput runId={runId} outputRef={outputRef} />}
    </ActivityCard>
  );
}

/** Fetches the full output behind an `outputRef` when it first renders. */
function LazyOutput({ runId, outputRef }: { runId: string; outputRef: string }) {
  const query = useQuery(
    orpc.runs.output.queryOptions({
      input: { id: runId, outputRef },
      staleTime: Number.POSITIVE_INFINITY,
    }),
  );
  if (query.isPending) {
    return <div className="text-meta text-muted-foreground">Loading output…</div>;
  }
  if (query.error) {
    return <div className="text-meta text-destructive">{query.error.message}</div>;
  }
  if (query.data.blocks.length === 0) {
    return <div className="text-meta text-muted-foreground">The output is empty.</div>;
  }
  return (
    <div className="space-y-2">
      {query.data.blocks.map((block, index) => {
        if (block.kind === "text") {
          return (
            <OutputViewer
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks carry no ids; transcript order is fixed
              key={index}
              output={{ type: "text", value: block.text }}
              truncated={block.truncated}
            />
          );
        }
        if (block.data !== null) {
          return (
            <OutputViewer
              // biome-ignore lint/suspicious/noArrayIndexKey: blocks carry no ids; transcript order is fixed
              key={index}
              output={{ type: "image", src: `data:${block.mediaType};base64,${block.data}` }}
            />
          );
        }
        return (
          // biome-ignore lint/suspicious/noArrayIndexKey: blocks carry no ids; transcript order is fixed
          <div key={index} className="text-meta text-muted-foreground">
            Image omitted for size ({block.mediaType})
          </div>
        );
      })}
    </div>
  );
}

function SteeringView({
  part,
  meta,
  runCreatedAt,
}: {
  part: SteeringPart;
  meta: TimelineMeta;
  runCreatedAt: string;
}) {
  const seq = steeringSeq(part.id);
  const at = (seq === null ? undefined : meta.steeringAt[seq]) ?? runCreatedAt;
  return (
    <SteeringNote author={principalLabel(part.author)} at={at}>
      {part.text}
    </SteeringNote>
  );
}

const awaitingWord: Record<ElicitationPart["elicitationKind"], string> = {
  approval: "awaiting approval",
  confirmation: "awaiting confirmation",
  choice: "awaiting choice",
  form: "awaiting input",
};

/**
 * An elicitation as one collapsible line. Unresolved and blocking is the one
 * machinery state that must not recede: the prompt keeps full contrast and
 * carries a wait marker. Resolution renders from the log, never optimistically;
 * resolve controls arrive with web intents (phase 4).
 */
function ElicitationView({ part }: { part: ElicitationPart }) {
  const resolved = part.resolution;
  const outcome =
    resolved === undefined
      ? undefined
      : (part.options.find((option) => option.id === resolved.optionId)?.label ??
        resolved.optionId);
  return (
    <Collapsible data-slot="elicitation-row">
      <CollapsibleTrigger className="group -mx-1.5 flex w-full items-center gap-2 rounded-sm px-1.5 py-0.5 text-left hover:bg-muted/50">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90" />
        <span className="flex min-w-0 items-baseline gap-2 text-chrome">
          <span
            className={cn(
              "truncate",
              resolved === undefined
                ? "font-medium"
                : "shrink-0 text-muted-foreground group-hover:text-foreground",
            )}
          >
            {part.prompt}
          </span>
          {resolved !== undefined && (
            <span className="truncate text-meta text-muted-foreground group-data-[state=open]:hidden">
              {outcome} by {principalLabel(resolved.by)}
            </span>
          )}
        </span>
        {resolved === undefined && (
          <span className="ml-auto flex shrink-0 items-center gap-1.5 pl-2 text-meta text-muted-foreground">
            {awaitingWord[part.elicitationKind]}
            <StatusDot tone="wait" />
          </span>
        )}
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1.5 ml-[5px] space-y-1.5 border-l pl-4 text-meta">
          <p>{part.prompt}</p>
          <p className="text-muted-foreground">
            Options: {part.options.map((option) => option.label).join(" · ")}
          </p>
          {resolved !== undefined && (
            <p className="text-muted-foreground">
              {outcome} by {principalLabel(resolved.by)} · <RelativeTime date={resolved.at} />
            </p>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/**
 * The escape hatch for `data` parts: a collapsed raw-JSON block labeled with
 * the part's name. Adapter noise (a payload of null) renders as nothing.
 */
function DataPartView({ part }: { part: DataPart }) {
  if (part.data === null) return null;
  return (
    <Collapsible data-slot="data-part">
      <CollapsibleTrigger className="group -mx-1.5 flex items-center gap-2 rounded-sm px-1.5 py-0.5 text-muted-foreground hover:bg-muted/50 hover:text-foreground">
        <ChevronRight className="size-3 shrink-0 transition-transform group-data-[state=open]:rotate-90" />
        <span className="font-mono text-meta">{part.name}</span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="mt-1 mb-1.5 ml-[5px] border-l pl-4">
          <OutputViewer output={{ type: "json", value: part.data }} />
        </div>
      </CollapsibleContent>
    </Collapsible>
  );
}

/** A message waiting for a turn boundary, rendered where it will land. */
function QueuedInputNote({ item }: { item: QueuedInputItem }) {
  return (
    <div className="rounded-md border border-dashed px-3 py-2">
      <div className="flex items-center gap-2 text-meta text-muted-foreground">
        <span className="font-medium text-foreground">{principalLabel(item.author)}</span>
        <span>{item.kind === "steering" ? "queued steer" : "queued follow-up"}</span>
        <RelativeTime date={item.queuedAt} />
      </div>
      <p className="mt-0.5 text-chat">{item.text}</p>
    </div>
  );
}
