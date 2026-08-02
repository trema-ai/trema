import type { Projection } from "@trema/projection";
import {
  acknowledge,
  planRender,
  type RenderPlan,
  retryDecision,
  type SurfaceDriver,
  SurfaceDriverError,
  type SurfaceRealization,
  type SurfaceRef,
} from "@trema/surfaces";

import type {
  CommitRealizationInput,
  RecordRenderFailureInput,
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
}

export interface SurfaceRealizationStore {
  claim(
    runId: string,
    ref: SurfaceRef,
    owner: string,
    ttlMs: number,
  ): Promise<SurfaceRealization | undefined>;
  stagePlan(input: StageRenderPlanInput): Promise<SurfaceRealization>;
  commit(input: CommitRealizationInput): Promise<SurfaceRealization>;
  recordFailure(input: RecordRenderFailureInput): Promise<SurfaceRealization>;
  release(id: string, owner: string): Promise<boolean>;
}

export type RenderSurfaceResult =
  | { status: "busy" }
  | { status: "noop"; realization: SurfaceRealization }
  | { status: "rendered"; operations: number; realization: SurfaceRealization }
  | {
      status: "retry_scheduled" | "terminal_failure";
      error: SurfaceDriverError;
      realization: SurfaceRealization;
    };

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
    await input.store.release(current.id, input.owner);
    return { status: "noop", realization: current };
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
    await input.store.release(committed.id, input.owner);
    return { status: "rendered", operations: 0, realization: committed };
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
    const applied = await input.driver.apply(plan.operations, {
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
    await input.store.release(committed.id, input.owner);
    return { status: "rendered", operations: plan.operations.length, realization: committed };
  } catch (caught) {
    if (caught instanceof SurfaceRealizationConflictError) throw caught;
    const error =
      caught instanceof SurfaceDriverError
        ? caught
        : new SurfaceDriverError("unknown", "Surface driver failed", {
            cause: caught,
            retryable: true,
          });
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

function sameSegments(
  left: SurfaceRealization["segments"],
  right: SurfaceRealization["segments"],
): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
