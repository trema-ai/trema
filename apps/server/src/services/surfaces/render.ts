import type { Projection } from "@trema/projection";
import {
  type ApplyResult,
  acknowledge,
  planRender,
  type RenderOperation,
  type RenderPlan,
  retryDecision,
  type SurfaceApplyContext,
  type SurfaceDriver,
  SurfaceDriverError,
  type SurfaceRealization,
  type SurfaceRef,
} from "@trema/surfaces";

import { log } from "#server/lib/logger/index.js";
import type {
  CommitRealizationInput,
  RecordNativeStopPendingInput,
  RecordRenderFailureInput,
  RecordRenderStopInput,
  StageRenderPlanInput,
} from "#server/services/surfaces/store.js";
import { SurfaceRealizationConflictError } from "#server/services/surfaces/store.js";

const DEFAULT_LEASE_TTL_MS = 30_000;

export interface RenderSurfaceInput {
  store: SurfaceRealizationStore;
  driver: SurfaceDriver;
  projection: Projection;
  ref: SurfaceRef;
  owner: string;
  canonicalRunUrl: string;
  leaseTtlMs?: number;
  /** Set only after the caller confirms an authoritative event-log truncation. */
  allowCursorRegression?: boolean;
  clock?: { now(): Date };
  /**
   * Durably submits a stop intent. `already_terminal` is the successful result
   * of losing the race to normal run completion, not a rendering failure.
   */
  requestRunStop: RequestRunStop;
}

export interface RunStopRequest {
  intentId: string;
  runId: string;
  ref: SurfaceRef;
}

export type RequestRunStop = (input: RunStopRequest) => Promise<"recorded" | "already_terminal">;

export interface SurfaceRealizationStore {
  claim(
    runId: string,
    ref: SurfaceRef,
    owner: string,
    ttlMs: number,
  ): Promise<SurfaceRealization | undefined>;
  stagePlan(input: StageRenderPlanInput): Promise<SurfaceRealization>;
  commit(input: CommitRealizationInput): Promise<SurfaceRealization>;
  claimPresence(
    id: string,
    owner: string,
    expectedVersion: number,
    ttlMs: number,
  ): Promise<boolean>;
  recordStopPending(input: RecordNativeStopPendingInput): Promise<SurfaceRealization>;
  recordFailure(input: RecordRenderFailureInput): Promise<SurfaceRealization>;
  recordStopped(input: RecordRenderStopInput): Promise<SurfaceRealization>;
  renew(id: string, owner: string, ttlMs: number): Promise<boolean>;
  release(id: string, owner: string): Promise<boolean>;
}

export type RenderSurfaceResult =
  | { status: "busy" }
  | { status: "noop"; realization: SurfaceRealization }
  | { status: "rendered"; operations: number; realization: SurfaceRealization }
  | { status: "stopped"; realization: SurfaceRealization }
  | {
      status: "retry_scheduled" | "terminal_failure";
      error: SurfaceDriverError;
      realization: SurfaceRealization;
    };

type ClaimedRenderSurfaceResult = Exclude<RenderSurfaceResult, { status: "busy" }>;

/**
 * Advances one persisted realization from a durable projection. The plan is
 * staged before Slack is called, and the cursor moves only after the driver
 * acknowledges every stable operation id and every created message reference.
 */
export async function renderSurface(input: RenderSurfaceInput): Promise<RenderSurfaceResult> {
  const realization = await input.store.claim(
    input.projection.runId,
    input.ref,
    input.owner,
    input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS,
  );
  if (realization === undefined) return { status: "busy" };
  const result = await renderClaimedSurface(input, realization);
  await updateAdvisoryPresence(input, result);
  return result;
}

async function renderClaimedSurface(
  input: RenderSurfaceInput,
  realization: SurfaceRealization,
): Promise<ClaimedRenderSurfaceResult> {
  if (realization.nativeStopPending) return submitNativeStop(input, realization);

  let current = realization;
  let plan: RenderPlan;
  try {
    plan = planRender(input.projection, current, input.driver.capabilities, {
      ...(input.allowCursorRegression === true ? { allowCursorRegression: true } : {}),
    });
  } catch (error) {
    await input.store.release(current.id, input.owner);
    throw error;
  }

  if (
    plan.operations.length === 0 &&
    plan.toCursor === current.renderedThroughSeq &&
    sameSegments(plan.nextSegments, current.segments)
  ) {
    const released = await releaseRealization(input.store, current, input.owner);
    return { status: "noop", realization: released };
  }

  if (plan.operations.length === 0) {
    const committed = await input.store.commit({
      id: current.id,
      owner: input.owner,
      expectedVersion: current.version,
      renderedThroughSeq: plan.toCursor,
      segments: plan.nextSegments,
      presentation: { dialect: input.driver.capabilities.dialect },
    });
    const released = await releaseRealization(input.store, committed, input.owner);
    return { status: "rendered", operations: 0, realization: released };
  }

  if (current.pendingPlan === undefined) {
    current = await input.store.stagePlan({
      id: current.id,
      owner: input.owner,
      expectedVersion: current.version,
      plan,
    });
  }

  try {
    const applied = await applyWithLeaseHeartbeat(input, current.id, plan.operations, {
      runId: input.projection.runId,
      ref: input.ref,
      canonicalRunUrl: input.canonicalRunUrl,
      realizationVersion: current.version,
    });
    const segments = acknowledge(plan, applied);
    const committed = await input.store.commit({
      id: current.id,
      owner: input.owner,
      expectedVersion: current.version,
      renderedThroughSeq: plan.toCursor,
      segments,
      presentation: { dialect: input.driver.capabilities.dialect },
    });
    const released = await releaseRealization(input.store, committed, input.owner);
    return { status: "rendered", operations: plan.operations.length, realization: released };
  } catch (caught) {
    if (caught instanceof SurfaceRealizationConflictError) throw caught;
    const error =
      caught instanceof SurfaceDriverError
        ? caught
        : new SurfaceDriverError("unknown", "Surface driver failed", {
            cause: caught,
            retryable: true,
          });
    if (error.code === "stopped_by_user") {
      const pending = await input.store.recordStopPending({
        id: current.id,
      });
      return submitNativeStop(input, pending);
    }
    const retry = retryDecision(error, current.retry.attempt);
    const failed = await input.store.recordFailure({
      id: current.id,
      owner: input.owner,
      expectedVersion: current.version,
      code: error.code,
      ...(retry.disposition === "terminal"
        ? { terminal: true }
        : { nextRetryAt: new Date((input.clock?.now() ?? new Date()).getTime() + retry.delayMs) }),
    });
    return {
      status: retry.disposition === "terminal" ? "terminal_failure" : "retry_scheduled",
      error,
      realization: failed,
    };
  }
}

async function updateAdvisoryPresence(
  input: RenderSurfaceInput,
  result: ClaimedRenderSurfaceResult,
): Promise<void> {
  let claimed = false;
  try {
    const ttlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
    claimed = await input.store.claimPresence(
      result.realization.id,
      input.owner,
      result.realization.version,
      ttlMs,
    );
    if (!claimed) return;
    const presence =
      result.status === "stopped" || result.status === "terminal_failure"
        ? "idle"
        : presenceFor(input.projection);
    await withLeaseHeartbeat(
      input,
      result.realization.id,
      () =>
        input.driver.presence(presence, {
          runId: input.projection.runId,
          ref: input.ref,
          canonicalRunUrl: input.canonicalRunUrl,
          realizationVersion: result.realization.version,
        }),
      "advisory presence update",
    );
  } catch (error) {
    log.warn("Surface presence update failed", { error });
  } finally {
    if (claimed) {
      try {
        if (!(await input.store.release(result.realization.id, input.owner))) {
          log.warn("Surface presence lease release failed", {
            realizationId: result.realization.id,
          });
        }
      } catch (error) {
        log.warn("Surface presence lease release failed", { error });
      }
    }
  }
}

function presenceFor(projection: Projection): "working" | "idle" {
  return projection.status === "pending" || projection.status === "running" ? "working" : "idle";
}

async function submitNativeStop(
  input: RenderSurfaceInput,
  current: SurfaceRealization,
): Promise<ClaimedRenderSurfaceResult> {
  try {
    await input.requestRunStop({
      intentId: `surface:${current.id}:stopped-by-user`,
      runId: input.projection.runId,
      ref: input.ref,
    });
  } catch (stopError) {
    const requestError = new SurfaceDriverError(
      "unavailable",
      "Failed to submit the native surface stop request",
      { cause: stopError, retryable: true },
    );
    const retry = retryDecision(requestError, current.retry.attempt);
    const failed = await input.store.recordFailure({
      id: current.id,
      owner: input.owner,
      expectedVersion: current.version,
      code: requestError.code,
      ...(retry.disposition === "terminal"
        ? { terminal: true }
        : {
            nextRetryAt: new Date((input.clock?.now() ?? new Date()).getTime() + retry.delayMs),
          }),
    });
    return {
      status: retry.disposition === "terminal" ? "terminal_failure" : "retry_scheduled",
      error: requestError,
      realization: failed,
    };
  }
  const stopped = await input.store.recordStopped({
    id: current.id,
  });
  return { status: "stopped", realization: stopped };
}

async function releaseRealization(
  store: SurfaceRealizationStore,
  realization: SurfaceRealization,
  owner: string,
): Promise<SurfaceRealization> {
  if (!(await store.release(realization.id, owner))) {
    throw new SurfaceRealizationConflictError(
      `surface realization lost its lease before release: ${realization.id}`,
    );
  }
  const { lease: _lease, ...released } = realization;
  return released;
}

/** Keeps ownership live while a throttled remote batch is in flight. */
async function applyWithLeaseHeartbeat(
  input: RenderSurfaceInput,
  realizationId: string,
  operations: RenderOperation[],
  context: SurfaceApplyContext,
): Promise<ApplyResult> {
  return withLeaseHeartbeat(
    input,
    realizationId,
    () => input.driver.apply(operations, context),
    "remote apply",
    (error) => error instanceof SurfaceDriverError && error.code === "stopped_by_user",
  );
}

async function withLeaseHeartbeat<Result>(
  input: RenderSurfaceInput,
  realizationId: string,
  operation: () => Promise<Result>,
  phase: string,
  prioritizeOperationError: (error: unknown) => boolean = () => false,
): Promise<Result> {
  const ttlMs = input.leaseTtlMs ?? DEFAULT_LEASE_TTL_MS;
  const intervalMs = Math.max(1, Math.floor(ttlMs / 3));
  let renewal: Promise<void> | undefined;
  let heartbeatError: unknown;

  const beginRenewal = (): void => {
    if (renewal !== undefined || heartbeatError !== undefined) return;
    renewal = input.store
      .renew(realizationId, input.owner, ttlMs)
      .then((renewed) => {
        if (!renewed) {
          throw new SurfaceRealizationConflictError(
            `surface realization lost its lease during ${phase}: ${realizationId}`,
          );
        }
      })
      .catch((error: unknown) => {
        heartbeatError = error;
      })
      .then(() => {
        renewal = undefined;
      });
  };

  const timer = setInterval(beginRenewal, intervalMs);
  timer.unref();
  let result: Result | undefined;
  let operationFailed = false;
  let operationError: unknown;
  try {
    result = await operation();
  } catch (error) {
    operationFailed = true;
    operationError = error;
  } finally {
    clearInterval(timer);
    await renewal;
  }

  // A native stop is an observed remote side effect with a separate durable
  // obligation. Let the caller persist it before surfacing lease-renewal
  // trouble, otherwise a replay may falsely acknowledge the stopped stream.
  if (operationFailed && prioritizeOperationError(operationError)) throw operationError;
  if (heartbeatError !== undefined) throw heartbeatError;
  if (!(await input.store.renew(realizationId, input.owner, ttlMs))) {
    throw new SurfaceRealizationConflictError(
      `surface realization lost its lease after ${phase}: ${realizationId}`,
    );
  }
  if (operationFailed) throw operationError;
  return result!;
}

function sameSegments(
  left: SurfaceRealization["segments"],
  right: SurfaceRealization["segments"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
