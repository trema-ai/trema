import type { FoldInput, RunStatus } from "@trema/projection";

/**
 * Pure logic behind the run view's timeline: SSE frame parsing, terminal-state
 * checks, the pause-gap tracker that turns segment boundaries into "waited 3h
 * 12m" lines, and small formatting helpers. Kept free of React so the
 * behavior is readable (and testable) on its own.
 */

/** Run states the API reports that a run never leaves. */
const TERMINAL_RUN_STATES: ReadonlySet<string> = new Set([
  "completed",
  "failed",
  "cancelled",
  "stale",
]);

export function isTerminalRunState(state: string | undefined): boolean {
  return state !== undefined && TERMINAL_RUN_STATES.has(state);
}

export function isTerminalProjection(status: RunStatus): boolean {
  return status === "completed" || status === "failed" || status === "cancelled";
}

/**
 * Parses one SSE data frame into a fold input. The stream carries the same
 * `{seq, at, event}` envelope as the paged read; anything else is unusable
 * and reads as null (the caller counts it, never throws).
 */
export function parseEventFrame(data: unknown): FoldInput | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const frame = parsed as { seq?: unknown; at?: unknown; event?: unknown };
  if (typeof frame.seq !== "number" || !Number.isSafeInteger(frame.seq)) return null;
  if (typeof frame.at !== "string") return null;
  return { seq: frame.seq, at: frame.at, event: frame.event };
}

/** Parses a `run-event-malformed` frame (`{"seq":N}`) into its seq, or null. */
export function parseMalformedFrame(data: unknown): number | null {
  if (typeof data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const seq = (parsed as { seq?: unknown }).seq;
  return typeof seq === "number" && Number.isSafeInteger(seq) ? seq : null;
}

/** One closed segment's boundary times, in segment order. */
export interface PauseBoundary {
  reason: string;
  /** When the `segment-end` event landed. */
  endAt: string;
  /** When the next event after the boundary landed, once one has. */
  resumeAt?: string;
}

/**
 * Timeline facts the projection deliberately does not carry: parts have no
 * timestamps, so boundary gaps and steering times are tracked beside the fold
 * from the same inputs, with the same seq-based idempotence.
 */
export interface TimelineMeta {
  /** Highest seq folded into this meta, mirroring the projection's cursor. */
  lastSeq: number;
  /** Whether an unclosed segment exists, mirroring the fold's segmenting. */
  openSegment: boolean;
  /** Whether the next event is the one that ends the last boundary's park. */
  awaitingResume: boolean;
  /** One entry per closed segment, in order. */
  boundaries: PauseBoundary[];
  /** `at` of each steering event, keyed by its seq. */
  steeringAt: Record<number, string>;
}

export function emptyTimelineMeta(): TimelineMeta {
  return { lastSeq: 0, openSegment: false, awaitingResume: false, boundaries: [], steeringAt: {} };
}

/**
 * Event types the fold turns into parts — the ones that open a segment.
 * `data` is handled separately: only durable data events become parts, so a
 * transient one must not open a segment here that the fold never creates.
 */
const PART_EVENT_TYPES: ReadonlySet<string> = new Set([
  "text-start",
  "text-delta",
  "text-end",
  "reasoning-start",
  "reasoning-delta",
  "reasoning-end",
  "tool-start",
  "tool-input-delta",
  "tool-input",
  "tool-note",
  "tool-result",
  "elicitation",
  "steering",
  "error",
]);

/** Mirrors the fold: a `data` event becomes a part unless marked transient. */
function isDurableData(type: string, event: unknown): boolean {
  if (type !== "data") return false;
  return (event as { transient?: unknown }).transient !== true;
}

function eventType(event: unknown): string | undefined {
  if (typeof event !== "object" || event === null) return undefined;
  const type = (event as { type?: unknown }).type;
  return typeof type === "string" ? type : undefined;
}

/**
 * Advances the meta with newly delivered events. Pure and idempotent over
 * re-delivery, like the fold's `advance`: stale seqs are skipped, and an
 * all-stale batch returns the same object.
 */
export function advanceTimelineMeta(
  meta: TimelineMeta,
  inputs: readonly FoldInput[],
): TimelineMeta {
  let draft: TimelineMeta | undefined;
  for (const input of inputs) {
    if (input.seq <= (draft ?? meta).lastSeq) continue;
    draft ??= { ...meta, boundaries: [...meta.boundaries], steeringAt: { ...meta.steeringAt } };
    draft.lastSeq = input.seq;
    const type = eventType(input.event);
    if (type === undefined) continue;
    if (draft.awaitingResume) {
      const position = draft.boundaries.length - 1;
      const last = draft.boundaries[position];
      if (last !== undefined) draft.boundaries[position] = { ...last, resumeAt: input.at };
      draft.awaitingResume = false;
    }
    if (type === "segment-end") {
      // Mirrors the fold: a boundary with nothing open closes nothing, so it
      // must not consume a slot in the closed-segment order either.
      if (draft.openSegment) {
        const reason = (input.event as { reason?: unknown }).reason;
        draft.boundaries.push({
          reason: typeof reason === "string" ? reason : "completed",
          endAt: input.at,
        });
        draft.openSegment = false;
        draft.awaitingResume = true;
      }
    } else if (PART_EVENT_TYPES.has(type) || isDurableData(type, input.event)) {
      draft.openSegment = true;
      if (type === "steering") draft.steeringAt[input.seq] = input.at;
    }
  }
  return draft ?? meta;
}

/** "3h 12m" style duration, coarse on purpose: two units, largest first. */
export function formatDuration(ms: number): string {
  const totalSeconds = Math.max(0, Math.round(ms / 1000));
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}m` : `${hours}h`;
  if (minutes > 0) return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  return `${seconds}s`;
}

/** The "waited 3h 12m" divider detail for a paused boundary, once resumed. */
export function parkDetail(boundary: PauseBoundary | undefined): string | undefined {
  if (boundary?.resumeAt === undefined) return undefined;
  const from = Date.parse(boundary.endAt);
  const to = Date.parse(boundary.resumeAt);
  if (!Number.isFinite(from) || !Number.isFinite(to) || to < from) return undefined;
  return `waited ${formatDuration(to - from)}`;
}

/** A principal as both the events and the run read carry it. */
export interface PrincipalLike {
  principalId: string;
  displayName?: string | undefined;
}

/** How a principal reads on screen: the display name, else the raw id. */
export function principalLabel(ref: PrincipalLike): string {
  return ref.displayName ?? ref.principalId;
}

/** The seq a fold-minted steering part id encodes, or null. */
export function steeringSeq(id: string): number | null {
  const match = /^steering-(\d+)$/.exec(id);
  if (match?.[1] === undefined) return null;
  const seq = Number(match[1]);
  return Number.isSafeInteger(seq) ? seq : null;
}

/** The harness usage shape, every field optional: the read serves raw json. */
export interface RunUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  costUsd?: number;
}

const USAGE_KEYS = [
  "inputTokens",
  "outputTokens",
  "totalTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
  "costUsd",
] as const;

/** Reads whichever usage fields the stored json actually carries. */
export function parseUsage(value: unknown): RunUsage | null {
  if (typeof value !== "object" || value === null) return null;
  const usage: RunUsage = {};
  let found = false;
  for (const key of USAGE_KEYS) {
    const field = (value as Record<string, unknown>)[key];
    if (typeof field === "number" && Number.isFinite(field)) {
      usage[key] = field;
      found = true;
    }
  }
  return found ? usage : null;
}
