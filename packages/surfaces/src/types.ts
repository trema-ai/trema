import type { DispatchIntent } from "@trema/harness";
import type { Part } from "@trema/projection";

/** A platform-neutral address at which a run is realized. */
export interface SurfaceRef {
  surface: string;
  locationRef: string;
  threadRef?: string;
}

/** Events a surface driver may normalize from its native protocol. */
export type SurfaceEvent =
  | { type: "intent"; id: string; intent: DispatchIntent }
  | { type: "message-deleted"; id: string; messageRef: string }
  | { type: "destination-deleted"; id: string }
  | { type: "installation-revoked"; id: string };

export interface CapabilityDescriptor {
  mutation: "edit" | "append-only" | "render-once";
  streaming: "delta" | "snapshot" | "none";
  dialect: "commonmark" | "mrkdwn" | "adaptive" | "plain" | "html-email";
  affordances: {
    buttons: boolean;
    forms: boolean;
    reactions: boolean;
    presence: boolean;
    threads: boolean;
    files: boolean;
  };
  budgets: {
    messageChars: number;
    actionsPerMessage?: number;
    flushIntervalMs: number;
    firstPaintMs: number;
    streamWindowMs?: number;
  };
  quirks: {
    updateAppends?: string[];
    blocksOnlyAtFinal?: boolean;
    ephemeralImmutable?: boolean;
  };
}

/** Projection content carried without any adapter SDK vocabulary. */
export interface RenderContent {
  /** Mandatory tier-zero representation and the input to character budgets. */
  text: string;
  /** Typed source parts for drivers capable of richer presentation. */
  parts: Part[];
}

interface OperationBase {
  /** Stable idempotency key for at-least-once delivery. */
  id: string;
  /** Stable across growth, replacement, completion, and replay. */
  messageId: string;
  segmentId: string;
  segmentIndex: number;
  messageIndex: number;
}

/** Previously acknowledged driver state for one mutable remote message. */
export interface PriorRenderState {
  /** Tier-zero content previously acknowledged by the destination. */
  text: string;
  /** Opaque driver state returned by the previous acknowledgement. */
  metadata?: Record<string, unknown>;
}

export type RenderOperation =
  | (OperationBase & {
      type: "create";
      /** Idempotent upsert by operation id; retries converge the existing message. */
      content: RenderContent;
      finalized: boolean;
    })
  | (OperationBase & {
      type: "append";
      remoteRef: string;
      text: string;
      prior: PriorRenderState;
    })
  | (OperationBase & {
      type: "replace";
      remoteRef: string;
      content: RenderContent;
      prior: PriorRenderState;
    })
  | (OperationBase & {
      type: "finalize";
      remoteRef: string;
      content: RenderContent;
      prior: PriorRenderState;
    })
  | (OperationBase & {
      type: "delete";
      remoteRef: string;
    });

export interface AppliedMessage {
  messageId: string;
  /** Required when a create operation allocated a remote message. */
  remoteRef?: string;
  /** Opaque, advisory driver state. Core correctness never depends on it. */
  metadata?: Record<string, unknown>;
}

/** One atomic acknowledgement. Partial batches are retried from the same cursor. */
export interface ApplyResult {
  appliedOperationIds: string[];
  messages: AppliedMessage[];
}

export interface RealizedMessage {
  id: string;
  index: number;
  remoteRef?: string;
  text: string;
  contentHash: string;
  finalized: boolean;
  metadata?: Record<string, unknown>;
}

export interface RealizedSegment {
  id: string;
  index: number;
  messages: RealizedMessage[];
  /** Current append-only snapshot; older messages remain as immutable history. */
  activeMessageIds?: string[];
}

/** Durable state for exactly one run and surface destination. */
export interface SurfaceRealization {
  id: string;
  orgId: string;
  runId: string;
  ref: SurfaceRef;
  renderedThroughSeq: number;
  segments: RealizedSegment[];
  presentation: Record<string, unknown>;
  /** Batch durably staged before remote apply and replayed until acknowledged. */
  pendingPlan?: RenderPlan;
  /** A truncated staged batch was applied and needs one authoritative follow-up plan. */
  reconciliationRequired: boolean;
  /** Optimistic concurrency revision, incremented after every state transition. */
  version: number;
  lease?: { owner: string; until: string };
  retry: {
    attempt: number;
    terminal: boolean;
    nextAt?: string;
    lastErrorCode?: SurfaceErrorCode;
  };
}

/** Non-empty plans must be durably staged before any driver operation is attempted. */
export interface RenderPlan {
  fromCursor: number;
  toCursor: number;
  operations: RenderOperation[];
  nextSegments: RealizedSegment[];
}

export interface PlanRenderOptions {
  /** Set only after confirming the projection cursor is the run's authoritative truncated end. */
  allowCursorRegression?: boolean;
}

export interface SurfaceApplyContext {
  runId: string;
  ref: SurfaceRef;
  /** Every non-canonical realization links back to the complete run view. */
  canonicalRunUrl: string;
  realizationVersion: number;
}

/** Driver seam. Native event types stay confined to its implementation. */
export interface SurfaceDriver<NativeEvent = unknown> {
  capabilities: CapabilityDescriptor;
  apply(operations: RenderOperation[], context: SurfaceApplyContext): Promise<ApplyResult>;
  presence(state: "working" | "idle", context: SurfaceApplyContext): Promise<void>;
  normalize(
    event: NativeEvent,
    ref: SurfaceRef,
  ): Promise<SurfaceEvent | null> | SurfaceEvent | null;
}

export type SurfaceErrorCode =
  | "rate_limited"
  | "unavailable"
  | "stopped_by_user"
  | "unauthorized"
  | "revoked"
  | "message_not_found"
  | "destination_not_found"
  | "invalid_request"
  | "permanent"
  | "unknown";

export class SurfaceDriverError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs: number | undefined;

  constructor(
    readonly code: SurfaceErrorCode,
    message: string,
    options: { retryable: boolean; retryAfterMs?: number; cause?: unknown },
  ) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "SurfaceDriverError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

export type RetryDecision = { disposition: "retry"; delayMs: number } | { disposition: "terminal" };
