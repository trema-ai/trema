import { randomUUID } from "node:crypto";

import type {
  RealizedSegment,
  RenderPlan,
  SurfaceErrorCode,
  SurfaceRealization,
  SurfaceRef,
} from "@trema/surfaces";

import type { Prisma } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";

type RealizationRow = {
  id: string;
  orgId: string;
  runId: string;
  surface: string;
  locationRef: string;
  threadRef: string;
  renderedThroughSeq: number;
  segments: Prisma.JsonValue;
  presentation: Prisma.JsonValue;
  pendingPlan: Prisma.JsonValue | null;
  reconciliationRequired: boolean;
  version: number;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  retryAttempt: number;
  terminalFailure: boolean;
  nextRetryAt: Date | null;
  lastErrorCode: string | null;
};

export interface SurfaceRealizationStoreOptions {
  db: Database;
  orgId: string;
  clock?: { now(): Date };
}

export interface CommitRealizationInput {
  id: string;
  owner: string;
  expectedVersion: number;
  renderedThroughSeq: number;
  segments: RealizedSegment[];
  presentation?: Record<string, unknown>;
}

export interface StageRenderPlanInput {
  id: string;
  owner: string;
  expectedVersion: number;
  plan: RenderPlan;
}

export interface RecordRenderFailureInput {
  id: string;
  owner: string;
  expectedVersion: number;
  code: SurfaceErrorCode;
  terminal?: boolean;
  nextRetryAt?: Date;
}

/** The renderer no longer owns the live revision it tried to mutate. */
export class SurfaceRealizationConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SurfaceRealizationConflictError";
  }
}

/**
 * Prisma persistence for applied rendering state. Claims, renewal, cursor
 * commits, and retry scheduling are all compare-and-set operations in the DB.
 */
export class PrismaSurfaceRealizationStore {
  readonly #db: Database;
  readonly #orgId: string;
  readonly #clock: { now(): Date };

  constructor(options: SurfaceRealizationStoreOptions) {
    this.#db = options.db;
    this.#orgId = options.orgId;
    this.#clock = options.clock ?? { now: () => new Date() };
  }

  async get(runId: string, ref: SurfaceRef): Promise<SurfaceRealization | undefined> {
    const row = await this.#db.surfaceRealization.findUnique({
      where: {
        runId_surface_locationRef_threadRef: {
          runId,
          surface: ref.surface,
          locationRef: ref.locationRef,
          threadRef: storedThreadRef(ref),
        },
      },
    });
    if (row === null || row.orgId !== this.#orgId) return undefined;
    return toRealization(row);
  }

  /** Atomically creates or claims one destination. A live foreign lease wins. */
  async claim(
    runId: string,
    ref: SurfaceRef,
    owner: string,
    ttlMs: number,
  ): Promise<SurfaceRealization | undefined> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("surface realization lease TTL must be a positive integer");
    }
    const now = this.#clock.now();
    const until = new Date(now.getTime() + ttlMs);
    const id = randomUUID();
    const [row] = await this.#db.$queryRaw<RealizationRow[]>`
      INSERT INTO "SurfaceRealization" (
        "id", "orgId", "runId", "surface", "locationRef", "threadRef",
        "leaseOwner", "leaseUntil", "updatedAt"
      ) VALUES (
        ${id}, ${this.#orgId}, ${runId}, ${ref.surface}, ${ref.locationRef},
        ${storedThreadRef(ref)}, ${owner}, ${until}, ${now}
      )
      ON CONFLICT ("runId", "surface", "locationRef", "threadRef")
      DO UPDATE SET
        "leaseOwner" = EXCLUDED."leaseOwner",
        "leaseUntil" = EXCLUDED."leaseUntil",
        "updatedAt" = EXCLUDED."updatedAt"
      WHERE "SurfaceRealization"."orgId" = ${this.#orgId}
        AND (
          "SurfaceRealization"."leaseOwner" = ${owner}
          OR "SurfaceRealization"."leaseUntil" IS NULL
          OR "SurfaceRealization"."leaseUntil" <= ${now}
        )
        AND (
          "SurfaceRealization"."nextRetryAt" IS NULL
          OR "SurfaceRealization"."nextRetryAt" <= ${now}
        )
        AND NOT "SurfaceRealization"."terminalFailure"
      RETURNING
        "id", "orgId", "runId", "surface", "locationRef", "threadRef",
        "renderedThroughSeq", "segments", "presentation", "pendingPlan",
        "reconciliationRequired", "version",
        "leaseOwner", "leaseUntil", "retryAttempt", "terminalFailure",
        "nextRetryAt", "lastErrorCode"`;
    return row === undefined ? undefined : toRealization(row);
  }

  /** Durably stages a non-empty batch before any remote operation is attempted. */
  async stagePlan(input: StageRenderPlanInput): Promise<SurfaceRealization> {
    if (input.plan.operations.length === 0) {
      throw new Error("only non-empty surface render plans need staging");
    }
    const now = this.#clock.now();
    const plan = JSON.stringify(input.plan);
    const [row] = await this.#db.$queryRaw<RealizationRow[]>`
      UPDATE "SurfaceRealization" AS realization
      SET "pendingPlan" = ${plan}::jsonb,
          "version" = "version" + 1,
          "updatedAt" = ${now}
      WHERE realization."id" = ${input.id}
        AND realization."orgId" = ${this.#orgId}
        AND realization."leaseOwner" = ${input.owner}
        AND realization."leaseUntil" > ${now}
        AND realization."version" = ${input.expectedVersion}
        AND realization."pendingPlan" IS NULL
        AND realization."renderedThroughSeq" = ${input.plan.fromCursor}
        AND ${input.plan.toCursor} <= (
          SELECT run."lastEventSeq" FROM "AgentRun" AS run
          WHERE run."id" = realization."runId" AND run."orgId" = realization."orgId"
        )
        AND (
          realization."renderedThroughSeq" <= ${input.plan.toCursor}
          OR ${input.plan.toCursor} = (
            SELECT run."lastEventSeq" FROM "AgentRun" AS run
            WHERE run."id" = realization."runId" AND run."orgId" = realization."orgId"
          )
        )
      RETURNING
        "id", "orgId", "runId", "surface", "locationRef", "threadRef",
        "renderedThroughSeq", "segments", "presentation", "pendingPlan",
        "reconciliationRequired", "version",
        "leaseOwner", "leaseUntil", "retryAttempt", "terminalFailure",
        "nextRetryAt", "lastErrorCode"`;
    if (row === undefined) {
      throw new SurfaceRealizationConflictError(
        `surface realization plan lost its lease or revision: ${input.id}`,
      );
    }
    return toRealization(row);
  }

  /** Extends only a lease that is still live and owned by this worker. */
  async renew(id: string, owner: string, ttlMs: number): Promise<boolean> {
    if (!Number.isSafeInteger(ttlMs) || ttlMs <= 0) {
      throw new Error("surface realization lease TTL must be a positive integer");
    }
    const now = this.#clock.now();
    const result = await this.#db.surfaceRealization.updateMany({
      where: { id, orgId: this.#orgId, leaseOwner: owner, leaseUntil: { gt: now } },
      data: { leaseUntil: new Date(now.getTime() + ttlMs) },
    });
    return result.count === 1;
  }

  /**
   * Commits acknowledged render state and moves its applied cursor once. Cursor
   * regression is allowed only to the run's current end, which is the guarded
   * reconciliation path after an authorized event-log truncation.
   */
  async commit(input: CommitRealizationInput): Promise<SurfaceRealization> {
    const now = this.#clock.now();
    const segments = JSON.stringify(input.segments);
    const presentation =
      input.presentation === undefined ? null : JSON.stringify(input.presentation);
    const [row] = await this.#db.$queryRaw<RealizationRow[]>`
      UPDATE "SurfaceRealization" AS realization
      SET "renderedThroughSeq" = ${input.renderedThroughSeq},
          "segments" = ${segments}::jsonb,
          "presentation" = COALESCE(${presentation}::jsonb, realization."presentation"),
          "reconciliationRequired" = CASE
            WHEN realization."pendingPlan" IS NULL THEN false
            ELSE (realization."pendingPlan"->>'toCursor')::integer > ${input.renderedThroughSeq}
          END,
          "pendingPlan" = NULL,
          "version" = "version" + 1,
          "retryAttempt" = 0,
          "terminalFailure" = false,
          "nextRetryAt" = NULL,
          "lastErrorCode" = NULL,
          "updatedAt" = ${now}
      WHERE realization."id" = ${input.id}
        AND realization."orgId" = ${this.#orgId}
        AND realization."leaseOwner" = ${input.owner}
        AND realization."leaseUntil" > ${now}
        AND realization."version" = ${input.expectedVersion}
        AND ${input.renderedThroughSeq} <= (
          SELECT run."lastEventSeq" FROM "AgentRun" AS run
          WHERE run."id" = realization."runId" AND run."orgId" = realization."orgId"
        )
        AND (
          realization."renderedThroughSeq" <= ${input.renderedThroughSeq}
          OR ${input.renderedThroughSeq} = (
            SELECT run."lastEventSeq" FROM "AgentRun" AS run
            WHERE run."id" = realization."runId" AND run."orgId" = realization."orgId"
          )
        )
      RETURNING
        "id", "orgId", "runId", "surface", "locationRef", "threadRef",
        "renderedThroughSeq", "segments", "presentation", "pendingPlan",
        "reconciliationRequired", "version",
        "leaseOwner", "leaseUntil", "retryAttempt", "terminalFailure",
        "nextRetryAt", "lastErrorCode"`;
    if (row === undefined) {
      throw new SurfaceRealizationConflictError(
        `surface realization commit lost its lease or revision: ${input.id}`,
      );
    }
    return toRealization(row);
  }

  /** Records a safe error code, preserves the cursor, and releases the lease. */
  async recordFailure(input: RecordRenderFailureInput): Promise<SurfaceRealization> {
    const now = this.#clock.now();
    const [row] = await this.#db.$queryRaw<RealizationRow[]>`
      UPDATE "SurfaceRealization"
      SET "version" = "version" + 1,
          "retryAttempt" = "retryAttempt" + 1,
          "terminalFailure" = ${input.terminal ?? false},
          "nextRetryAt" = ${input.nextRetryAt ?? null},
          "lastErrorCode" = ${input.code},
          "leaseOwner" = NULL,
          "leaseUntil" = NULL,
          "updatedAt" = ${now}
      WHERE "id" = ${input.id}
        AND "orgId" = ${this.#orgId}
        AND "leaseOwner" = ${input.owner}
        AND "leaseUntil" > ${now}
        AND "version" = ${input.expectedVersion}
      RETURNING
        "id", "orgId", "runId", "surface", "locationRef", "threadRef",
        "renderedThroughSeq", "segments", "presentation", "pendingPlan",
        "reconciliationRequired", "version",
        "leaseOwner", "leaseUntil", "retryAttempt", "terminalFailure",
        "nextRetryAt", "lastErrorCode"`;
    if (row === undefined) {
      throw new SurfaceRealizationConflictError(
        `surface realization failure lost its lease or revision: ${input.id}`,
      );
    }
    return toRealization(row);
  }

  async release(id: string, owner: string): Promise<boolean> {
    const result = await this.#db.surfaceRealization.updateMany({
      where: { id, orgId: this.#orgId, leaseOwner: owner },
      data: { leaseOwner: null, leaseUntil: null },
    });
    return result.count === 1;
  }
}

function storedThreadRef(ref: SurfaceRef): string {
  return ref.threadRef ?? "";
}

function toRealization(row: RealizationRow): SurfaceRealization {
  const threadRef = row.threadRef === "" ? undefined : row.threadRef;
  const lastErrorCode = row.lastErrorCode as SurfaceErrorCode | null;
  return {
    id: row.id,
    orgId: row.orgId,
    runId: row.runId,
    ref: {
      surface: row.surface,
      locationRef: row.locationRef,
      ...(threadRef === undefined ? {} : { threadRef }),
    },
    renderedThroughSeq: row.renderedThroughSeq,
    segments: row.segments as unknown as RealizedSegment[],
    presentation: row.presentation as Record<string, unknown>,
    ...(row.pendingPlan === null ? {} : { pendingPlan: row.pendingPlan as unknown as RenderPlan }),
    reconciliationRequired: row.reconciliationRequired,
    version: row.version,
    ...(row.leaseOwner === null || row.leaseUntil === null
      ? {}
      : { lease: { owner: row.leaseOwner, until: row.leaseUntil.toISOString() } }),
    retry: {
      attempt: row.retryAttempt,
      terminal: row.terminalFailure,
      ...(row.nextRetryAt === null ? {} : { nextAt: row.nextRetryAt.toISOString() }),
      ...(lastErrorCode === null ? {} : { lastErrorCode }),
    },
  };
}
