import type { RunEventData } from "@trema/harness";
import { RunEventDataSchema } from "@trema/harness";
import type {
  ActivityPart,
  FoldInput,
  Part,
  Projection,
  ReasoningPart,
  RunStatus,
  Segment,
  SegmentEndReason,
} from "#projection/types.js";

/**
 * Folds a run's full event log into its projection.
 * Pure, deterministic, and total: any input list yields a projection —
 * unrecognized or malformed events are counted, never thrown.
 */
export function fold(runId: string, events: readonly FoldInput[]): Projection {
  return advance({ runId, status: "pending", segments: [], unknownEvents: 0, lastSeq: 0 }, events);
}

/**
 * Advances a projection with newly delivered events.
 *
 * `fold(runId, all)` ≡ `advance(fold(runId, first), rest)` for every split
 * point — the incremental path and the batch path are one code path.
 *
 * Immutable-in, fresh-object-out: the input projection is never mutated, and
 * the result shares every untouched segment and part by reference, so React
 * consumers get referential change detection for free. When every event is
 * stale (`seq <= projection.lastSeq`), the input is returned unchanged.
 */
export function advance(projection: Projection, newEvents: readonly FoldInput[]): Projection {
  let draft: Draft | undefined;
  let lastSeq = projection.lastSeq;

  for (const input of newEvents) {
    // Idempotent re-delivery: paged reads and SSE reconnects may overlap.
    if (input.seq <= lastSeq) continue;
    lastSeq = input.seq;
    draft ??= new Draft(projection);
    draft.lastSeq = input.seq;

    // Total over raw input: unknown types and malformed known payloads are
    // one skip count — the run view renders it as "n unrecognized events".
    const parsed = RunEventDataSchema.safeParse(input.event);
    if (!parsed.success) {
      draft.unknownEvents += 1;
      continue;
    }
    applyEvent(draft, parsed.data, input.seq);
  }

  return draft === undefined ? projection : draft.finish();
}

function applyEvent(draft: Draft, event: RunEventData, seq: number): void {
  switch (event.type) {
    // Lifecycle events settle every still-streaming part first (the
    // settle-before-close rule): a resume re-emits `run-started`, so a block
    // left open by a crash or pause is never `streaming` forever.
    case "run-started":
      draft.settleAll();
      draft.status = "running";
      break;
    case "run-finished":
      draft.settleAll();
      draft.status = event.outcome;
      if (event.usage !== undefined) draft.usage = event.usage;
      break;
    case "turn-started":
      // Checkpoint metadata only; nothing emits these today and the fold
      // must not depend on them.
      break;
    case "turn-finished":
      draft.settleAll(
        event.stopReason === "error" || event.stopReason === "aborted"
          ? `turn ended: ${event.stopReason}`
          : undefined,
      );
      break;

    case "text-start": {
      const part = draft.mutableByKey("text", event.blockId);
      if (part === undefined) {
        draft.appendPart({ kind: "text", id: event.blockId, status: "streaming", markdown: "" });
      } else {
        part.status = "streaming";
      }
      break;
    }
    case "text-delta": {
      // Implicit open: a delta without its start means the start was lost
      // (crash-write tolerance), not that the content should be dropped.
      const part = draft.mutableByKey("text", event.blockId);
      if (part === undefined) {
        draft.appendPart({
          kind: "text",
          id: event.blockId,
          status: "streaming",
          markdown: event.delta,
        });
      } else {
        part.markdown += event.delta;
      }
      break;
    }
    case "text-end": {
      const part = draft.mutableByKey("text", event.blockId);
      if (part === undefined) {
        draft.appendPart({ kind: "text", id: event.blockId, status: "done", markdown: "" });
      } else {
        part.status = "done";
      }
      break;
    }

    case "reasoning-start": {
      const part = draft.mutableByKey("reasoning", event.blockId);
      if (part === undefined) {
        draft.appendPart({ kind: "reasoning", id: event.blockId, status: "streaming", text: "" });
      } else {
        part.status = "streaming";
      }
      break;
    }
    case "reasoning-delta": {
      const part = draft.mutableByKey("reasoning", event.blockId);
      if (part === undefined) {
        draft.appendPart({
          kind: "reasoning",
          id: event.blockId,
          status: "streaming",
          text: event.delta,
        });
      } else {
        part.text += event.delta;
      }
      break;
    }
    case "reasoning-end": {
      const part =
        draft.mutableByKey("reasoning", event.blockId) ??
        draft.appendPart<ReasoningPart>({
          kind: "reasoning",
          id: event.blockId,
          status: "done",
          text: "",
        });
      part.status = "done";
      if (event.redacted !== undefined) part.redacted = event.redacted;
      break;
    }

    case "tool-start": {
      const part = draft.mutableByKey("activity", event.callId);
      if (part === undefined) {
        draft.appendPart({
          kind: "activity",
          id: event.callId,
          status: "streaming",
          callId: event.callId,
          name: event.name,
          title: event.title,
          toolKind: event.kind,
          notes: [],
        });
      } else {
        // A start for a known call refreshes identity fields and reopens the
        // part, mirroring `text-start`/`reasoning-start`.
        part.name = event.name;
        part.title = event.title;
        part.toolKind = event.kind;
        part.status = "streaming";
      }
      break;
    }
    case "tool-input-delta": {
      const part = draft.ensureActivity(event.callId);
      part.input = (part.input ?? "") + event.delta;
      break;
    }
    case "tool-input": {
      // The parsed final input replaces whatever streamed in.
      const part = draft.ensureActivity(event.callId);
      const text = JSON.stringify(event.input);
      if (text !== undefined) part.input = text;
      break;
    }
    case "tool-note": {
      draft.ensureActivity(event.callId).notes.push(event.note);
      break;
    }
    case "tool-result": {
      // Settles its own part — even one opened before a pause in a closed
      // segment (a resumed gated call reports back to the original card).
      const part = draft.ensureActivity(event.callId);
      part.result = {
        status: event.status,
        summary: event.summary,
        ...(event.outputRef === undefined ? {} : { outputRef: event.outputRef }),
      };
      part.status = "done";
      break;
    }

    case "elicitation": {
      const part = draft.mutableByKey("elicitation", event.elicitationId);
      if (part === undefined) {
        draft.appendPart({
          kind: "elicitation",
          id: event.elicitationId,
          elicitationId: event.elicitationId,
          elicitationKind: event.kind,
          prompt: event.prompt,
          options: event.options,
          blocking: event.blocking,
        });
      } else {
        part.elicitationKind = event.kind;
        part.prompt = event.prompt;
        part.options = event.options;
        part.blocking = event.blocking;
      }
      break;
    }
    case "elicitation-resolved": {
      // Mutates the matching part wherever it sits — usually a prior, closed
      // segment. An orphan resolution is tolerated: the log wins, and a
      // reader must not fail on a resolution whose question it never saw.
      const part = draft.mutableByKey("elicitation", event.elicitationId);
      if (part !== undefined) {
        part.resolution = { optionId: event.optionId, by: event.by, at: event.at };
      }
      break;
    }

    case "segment-end":
      draft.settleAll();
      draft.closeSegment(event.reason);
      // Paused mirrors the lifecycle until a subsequent `run-started`; a
      // terminal status is never downgraded by a stray boundary.
      if (event.reason === "paused" && !isTerminal(draft.status)) draft.status = "paused";
      break;

    case "steering":
      draft.appendPart({
        kind: "steering",
        id: `steering-${seq}`,
        author: event.author,
        text: event.text,
      });
      break;
    case "error":
      draft.appendPart({
        kind: "error",
        id: `error-${seq}`,
        message: event.message,
        recoverable: event.recoverable,
      });
      break;

    case "data": {
      // Transient payloads never become parts; durable ones reconcile by id.
      if (event.transient === true) break;
      const id = event.id ?? `${event.name}#${seq}`;
      const part = event.id === undefined ? undefined : draft.mutableByKey("data", event.id);
      if (part === undefined) {
        draft.appendPart({ kind: "data", id, name: event.name, data: event.data });
      } else {
        part.name = event.name;
        part.data = event.data;
      }
      break;
    }
  }
}

function isTerminal(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Copy-on-write working state for one `advance` pass. The prior projection's
 * segments and parts are shared until first touched; anything touched is
 * cloned exactly once, so the pass can mutate freely without ever writing
 * into the input.
 */
class Draft {
  readonly runId: string;
  status: RunStatus;
  usage: Projection["usage"];
  unknownEvents: number;
  lastSeq: number;
  private readonly segments: Segment[];
  /** Segment array positions whose object and parts array were cloned this pass. */
  private readonly clonedSegments = new Set<number>();
  /** Part objects created or cloned this pass — safe to mutate. */
  private readonly ownedParts = new Set<Part>();

  constructor(prior: Projection) {
    this.runId = prior.runId;
    this.status = prior.status;
    this.usage = prior.usage;
    this.unknownEvents = prior.unknownEvents;
    this.lastSeq = prior.lastSeq;
    this.segments = [...prior.segments];
  }

  finish(): Projection {
    return {
      runId: this.runId,
      status: this.status,
      segments: this.segments,
      ...(this.usage === undefined ? {} : { usage: this.usage }),
      unknownEvents: this.unknownEvents,
      lastSeq: this.lastSeq,
    };
  }

  /** Appends a part, opening a new segment when the last one is closed. */
  appendPart<P extends Part>(part: P): P {
    this.ownedParts.add(part);
    const lastPos = this.segments.length - 1;
    const last = this.segments[lastPos];
    if (last !== undefined && last.end === undefined) {
      this.mutableSegment(lastPos).parts.push(part);
    } else {
      const segment: Segment = { index: last === undefined ? 0 : last.index + 1, parts: [part] };
      this.segments.push(segment);
      this.clonedSegments.add(this.segments.length - 1);
    }
    return part;
  }

  /** Finds the newest part of a kind by id and returns a mutable clone of it. */
  mutableByKey<K extends Part["kind"]>(
    kind: K,
    id: string,
  ): Extract<Part, { kind: K }> | undefined {
    for (let pos = this.segments.length - 1; pos >= 0; pos -= 1) {
      const parts = this.segments[pos]!.parts;
      for (let idx = parts.length - 1; idx >= 0; idx -= 1) {
        const part = parts[idx]!;
        if (part.kind === kind && part.id === id) {
          return this.mutablePart(pos, idx) as Extract<Part, { kind: K }>;
        }
      }
    }
    return undefined;
  }

  /** Finds or implicitly opens the activity part for a call. */
  ensureActivity(callId: string): ActivityPart {
    return (
      this.mutableByKey("activity", callId) ??
      this.appendPart({
        kind: "activity",
        id: callId,
        status: "streaming",
        callId,
        name: "unknown",
        title: "Tool call",
        toolKind: "other",
        notes: [],
      })
    );
  }

  /** Marks every streaming part done; an error context lands on unresolved activities. */
  settleAll(errorContext?: string): void {
    for (let pos = 0; pos < this.segments.length; pos += 1) {
      const parts = this.segments[pos]!.parts;
      for (let idx = 0; idx < parts.length; idx += 1) {
        const part = parts[idx]!;
        if (part.kind !== "text" && part.kind !== "reasoning" && part.kind !== "activity") continue;
        if (part.status !== "streaming") continue;
        const mutable = this.mutablePart(pos, idx) as typeof part;
        mutable.status = "done";
        if (
          errorContext !== undefined &&
          mutable.kind === "activity" &&
          mutable.result === undefined
        ) {
          // The call was still in flight when the turn died; the only slot a
          // part offers for that fact is an error result.
          mutable.result = { status: "error", summary: errorContext };
        }
      }
    }
  }

  /** Closes the open segment; it keeps its `end` even if parts mutate later. */
  closeSegment(reason: SegmentEndReason): void {
    const lastPos = this.segments.length - 1;
    const last = this.segments[lastPos];
    if (last !== undefined && last.end === undefined) {
      this.mutableSegment(lastPos).end = { reason };
    }
  }

  private mutableSegment(pos: number): Segment {
    if (!this.clonedSegments.has(pos)) {
      const prior = this.segments[pos]!;
      this.segments[pos] = { ...prior, parts: [...prior.parts] };
      this.clonedSegments.add(pos);
    }
    return this.segments[pos]!;
  }

  private mutablePart(pos: number, idx: number): Part {
    const segment = this.mutableSegment(pos);
    const part = segment.parts[idx]!;
    if (this.ownedParts.has(part)) return part;
    const clone: Part =
      part.kind === "activity" ? { ...part, notes: [...part.notes] } : { ...part };
    segment.parts[idx] = clone;
    this.ownedParts.add(clone);
    return clone;
  }
}
