import { randomUUID } from "node:crypto";

import type { PrincipalRef } from "@trema/harness";

import type { Prisma, Schedule, ScheduleStatus } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import type { RunServices } from "#/services/runs/index.js";
import { startRun } from "#/services/runs/index.js";
import { assertKnownTimezone, cronTicks, parseCron } from "#/services/schedules/cron.js";

export type { CronExpression, CronTicksOptions } from "./cron.js";
export {
  assertKnownTimezone,
  CronParseError,
  cronTicks,
  DEFAULT_MAX_LOOKBACK_MS,
  isKnownTimezone,
  parseCron,
} from "./cron.js";

/** A schedule that cannot start a run. */
export class ScheduleNotFirableError extends Error {
  constructor(
    readonly scheduleId: string,
    readonly reason: "scope_unbound",
    message: string,
  ) {
    super(message);
    this.name = "ScheduleNotFirableError";
  }
}

/** An unsupported status change. */
export class ScheduleStatusError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScheduleStatusError";
  }
}

/** The values a schedule is created with. */
export interface CreateScheduleInput {
  orgId: string;
  scopeId: string;
  cron: string;
  timezone: string;
  prompt: string;
  createdById: string;
  threadRef?: string;
  toolAllowlist?: string[];
  /** A schedule an agent proposes stays `proposed` until a human activates it. */
  status?: Extract<ScheduleStatus, "proposed" | "active">;
  /** Required when the schedule is created active. */
  activatedById?: string;
}

/**
 * Creates a schedule.
 * @throws {CronParseError} When the expression or the time zone is invalid.
 * @throws {ScheduleStatusError} When an active schedule names no activator.
 */
export async function createSchedule(db: Database, input: CreateScheduleInput): Promise<Schedule> {
  parseCron(input.cron);
  assertKnownTimezone(input.timezone);
  const status = input.status ?? "proposed";
  if (status === "active" && input.activatedById === undefined) {
    throw new ScheduleStatusError("An active schedule needs the principal who activated it");
  }

  const id = randomUUID();
  const created = await db.schedule.create({
    data: {
      id,
      orgId: input.orgId,
      scopeId: input.scopeId,
      // Firings of one schedule share a thread of their own, which is what makes
      // overlap detection a per-schedule question.
      threadRef: input.threadRef ?? `schedule:${id}`,
      cron: input.cron,
      timezone: input.timezone,
      prompt: input.prompt,
      toolAllowlist: input.toolAllowlist ?? [],
      status,
      createdById: input.createdById,
      ...(input.activatedById === undefined ? {} : { activatedById: input.activatedById }),
    },
  });
  log.info("Schedule created", { scheduleId: created.id, status: created.status });
  return created;
}

/** The values a schedule can be edited with. */
export interface UpdateScheduleInput {
  orgId: string;
  scheduleId: string;
  cron?: string;
  timezone?: string;
  prompt?: string;
  toolAllowlist?: string[];
}

/**
 * Edits a schedule's standing configuration.
 * @throws {CronParseError} When a new expression or time zone is invalid.
 * @throws {ScheduleStatusError} When the schedule is archived.
 */
export async function updateSchedule(db: Database, input: UpdateScheduleInput): Promise<Schedule> {
  const schedule = await requireSchedule(db, input.orgId, input.scheduleId);
  if (schedule.status === "archived") {
    throw new ScheduleStatusError("An archived schedule cannot be edited");
  }
  if (input.cron !== undefined) parseCron(input.cron);
  if (input.timezone !== undefined) assertKnownTimezone(input.timezone);

  return db.schedule.update({
    where: { orgId_id: { orgId: input.orgId, id: input.scheduleId } },
    data: {
      ...(input.cron === undefined ? {} : { cron: input.cron }),
      ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.toolAllowlist === undefined ? {} : { toolAllowlist: input.toolAllowlist }),
    },
  });
}

/** The status change a principal requests. */
export interface SetScheduleStatusInput {
  orgId: string;
  scheduleId: string;
  status: ScheduleStatus;
  /** The principal recorded as the activator when a schedule becomes active. */
  byPrincipalId: string;
}

const LEGAL_STATUS_CHANGES: Record<ScheduleStatus, ScheduleStatus[]> = {
  proposed: ["active", "archived"],
  active: ["paused", "archived"],
  paused: ["active", "archived"],
  archived: [],
};

/**
 * Changes a schedule's status. Activation records the human who took
 * responsibility for it; a pause stops ticks immediately and leaves runs that
 * earlier firings started alone.
 * @throws {ScheduleStatusError} When the change is not legal.
 */
export async function setScheduleStatus(
  db: Database,
  input: SetScheduleStatusInput,
): Promise<Schedule> {
  const schedule = await requireSchedule(db, input.orgId, input.scheduleId);
  if (schedule.status === input.status) return schedule;
  if (!LEGAL_STATUS_CHANGES[schedule.status].includes(input.status)) {
    throw new ScheduleStatusError(`A ${schedule.status} schedule cannot become ${input.status}`);
  }

  const updated = await db.schedule.update({
    where: { orgId_id: { orgId: input.orgId, id: input.scheduleId } },
    data: {
      status: input.status,
      ...(input.status === "active" ? { activatedById: input.byPrincipalId } : {}),
      // Ticks that passed while the schedule was paused are not made up.
      ...(input.status === "active" ? { lastTickAt: new Date() } : {}),
    },
  });
  log.info("Schedule status changed", {
    scheduleId: updated.id,
    from: schedule.status,
    to: updated.status,
  });
  return updated;
}

/** Lists a scope's schedules, or every schedule in the organization. */
export async function listSchedules(
  db: Database,
  input: { orgId: string; scopeId?: string; status?: ScheduleStatus },
): Promise<Schedule[]> {
  return db.schedule.findMany({
    where: {
      orgId: input.orgId,
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * @throws {Error} When the schedule does not exist in the organization.
 */
export async function requireSchedule(
  db: Database,
  orgId: string,
  scheduleId: string,
): Promise<Schedule> {
  const schedule = await db.schedule.findFirst({ where: { orgId, id: scheduleId } });
  if (schedule === null) throw new Error(`unknown schedule: ${scheduleId}`);
  return schedule;
}

/** What one evaluation of a schedule did. */
export interface ScheduleTickResult {
  outcome: "started" | "skipped_overlap" | "skipped_missed" | "not_due" | "inactive";
  /** The tick the evaluation acted on. */
  tickAt?: Date;
  runId?: string;
  /** Ticks this evaluation recorded as skipped. */
  skipped: number;
}

/** The schedule to evaluate, the time to evaluate it at, and the run services to start it with. */
export interface TickScheduleOptions {
  services: RunServices;
  schedule: Schedule;
  now?: Date;
  /** Oldest tick the evaluation considers, as a distance back from `now`. */
  maxLookbackMs?: number;
}

async function recordFiring(
  db: Database,
  data: {
    orgId: string;
    scheduleId: string;
    tickAt: Date;
    outcome: Prisma.ScheduleFiringCreateInput["outcome"];
    runId?: string | null;
  },
): Promise<void> {
  try {
    await db.scheduleFiring.create({
      data: {
        orgId: data.orgId,
        scheduleId: data.scheduleId,
        tickAt: data.tickAt,
        outcome: data.outcome,
        ...(data.runId === undefined || data.runId === null ? {} : { runId: data.runId }),
      },
    });
  } catch (error) {
    // One tick is recorded once. A second evaluator reaching the same minute is
    // not a failure, it is the reason the row is unique.
    if (
      typeof error === "object" &&
      error !== null &&
      (error as { code?: unknown }).code === "P2002"
    ) {
      return;
    }
    throw error;
  }
}

/**
 * Evaluates one schedule's due ticks.
 *
 * Only the newest due tick can start a run. Earlier ones are recorded as missed
 * and never made up: the next tick delivers, and a visible skip count beats a
 * surprise backlog. A tick that finds the schedule's thread still busy is
 * skipped for overlap, because ticks recur while a person waiting on a reply
 * does not.
 *
 * The run a tick starts is completely normal: service mode against the
 * schedule's scope, the same policy snapshot, the same approval gates. A
 * schedule automates the asking, never the approving.
 * @throws {ScheduleNotFirableError} When the schedule's scope has no bound location.
 */
export async function tickSchedule(options: TickScheduleOptions): Promise<ScheduleTickResult> {
  const { schedule, services } = options;
  const db = services.db;
  const now = options.now ?? new Date();
  if (schedule.status !== "active") return { outcome: "inactive", skipped: 0 };

  const ticks = cronTicks(parseCron(schedule.cron), schedule.timezone, {
    after: schedule.lastTickAt ?? schedule.createdAt,
    until: now,
    ...(options.maxLookbackMs === undefined ? {} : { maxLookbackMs: options.maxLookbackMs }),
  });
  if (ticks.length === 0) return { outcome: "not_due", skipped: 0 };

  const due = ticks.at(-1)!;
  const missed = ticks.slice(0, -1);
  for (const tick of missed) {
    await recordFiring(db, {
      orgId: schedule.orgId,
      scheduleId: schedule.id,
      tickAt: tick,
      outcome: "skipped_missed",
    });
  }

  const active = await services.store.findActiveRun(schedule.threadRef);
  if (active !== undefined) {
    await recordFiring(db, {
      orgId: schedule.orgId,
      scheduleId: schedule.id,
      tickAt: due,
      outcome: "skipped_overlap",
    });
    await db.schedule.update({
      where: { orgId_id: { orgId: schedule.orgId, id: schedule.id } },
      data: { lastTickAt: due, skippedCount: { increment: missed.length + 1 } },
    });
    log.info("Schedule tick skipped", {
      scheduleId: schedule.id,
      reason: "overlap",
      activeRunId: active.id,
      missed: missed.length,
    });
    return { outcome: "skipped_overlap", tickAt: due, skipped: missed.length + 1 };
  }

  const location = await db.binding.findFirst({
    where: { orgId: schedule.orgId, scopeId: schedule.scopeId },
    orderBy: { createdAt: "asc" },
  });
  if (location === null) {
    throw new ScheduleNotFirableError(
      schedule.id,
      "scope_unbound",
      `The schedule's scope has no bound surface location: ${schedule.scopeId}`,
    );
  }

  const requesterPrincipalId = schedule.activatedById ?? schedule.createdById;
  const author: PrincipalRef = { principalId: requesterPrincipalId };
  const started = await startRun({
    services,
    input: {
      // The tick is part of the key, so a repeated evaluation of one minute
      // cannot start a second run.
      idempotencyKey: `schedule:${schedule.id}:${due.toISOString()}`,
      trigger: "schedule",
      surface: location.surface,
      locationRef: location.locationRef,
      threadRef: schedule.threadRef,
      requester: { principalId: requesterPrincipalId },
      message: { role: "user", blocks: [{ type: "text", text: schedule.prompt }] },
      author,
      ...(schedule.toolAllowlist.length === 0 ? {} : { toolAllowlist: schedule.toolAllowlist }),
    },
  });

  await recordFiring(db, {
    orgId: schedule.orgId,
    scheduleId: schedule.id,
    tickAt: due,
    outcome: "started",
    runId: started.runId,
  });
  await db.schedule.update({
    where: { orgId_id: { orgId: schedule.orgId, id: schedule.id } },
    data: {
      lastFiredAt: due,
      lastTickAt: due,
      ...(missed.length === 0 ? {} : { skippedCount: { increment: missed.length } }),
    },
  });
  log.info("Schedule fired", {
    scheduleId: schedule.id,
    runId: started.runId,
    missed: missed.length,
  });
  return {
    outcome: "started",
    tickAt: due,
    skipped: missed.length,
    ...(started.runId === null ? {} : { runId: started.runId }),
  };
}

/** Evaluates every active schedule in one organization. */
export async function tickSchedules(options: {
  services: RunServices;
  now?: Date;
  maxLookbackMs?: number;
}): Promise<Map<string, ScheduleTickResult>> {
  const schedules = await listSchedules(options.services.db, {
    orgId: options.services.orgId,
    status: "active",
  });
  const results = new Map<string, ScheduleTickResult>();
  for (const schedule of schedules) {
    try {
      results.set(
        schedule.id,
        await tickSchedule({
          services: options.services,
          schedule,
          ...(options.now === undefined ? {} : { now: options.now }),
          ...(options.maxLookbackMs === undefined ? {} : { maxLookbackMs: options.maxLookbackMs }),
        }),
      );
    } catch (error) {
      log.error("Schedule tick failed", { scheduleId: schedule.id, error });
    }
  }
  return results;
}
