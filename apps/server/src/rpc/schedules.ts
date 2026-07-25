import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { Schedule } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { orgScoped, requireCapability } from "#/rpc/builders.js";
import { authorize, type AuthorizePrincipal } from "#/services/authorize/index.js";
import {
  CronParseError,
  createSchedule,
  listSchedules,
  requireSchedule,
  ScheduleStatusError,
  setScheduleStatus,
  updateSchedule,
} from "#/services/schedules/index.js";

const statusSchema = z
  .enum(["proposed", "active", "paused", "archived"])
  .describe(
    "`proposed` waits for a human, `active` ticks, `paused` stops ticking, `archived` leaves the active list.",
  );

const scheduleSchema = z
  .object({
    id: z.string().describe("The schedule's unique ID. A UUID."),
    scopeId: z.string().describe("The scope its firings open a session against."),
    threadRef: z.string().describe("The thread its firings serialize on."),
    cron: z.string().describe("The five-field cron expression."),
    timezone: z.string().describe("The IANA time zone the expression is read in."),
    prompt: z.string().describe("The message each firing starts with."),
    toolAllowlist: z
      .array(z.string())
      .describe("Narrows the session's resolved tools. An empty list means no narrowing."),
    status: statusSchema,
    createdById: z.string().describe("The principal who created the schedule."),
    activatedById: z
      .string()
      .nullable()
      .describe("The principal who took responsibility for it running unattended."),
    lastFiredAt: z
      .string()
      .nullable()
      .describe("When a firing last started a run. An ISO 8601 date-time."),
    skippedCount: z.number().int().describe("Ticks skipped for overlap or for passing unnoticed."),
  })
  .describe("One standing schedule.");

function serialize(schedule: Schedule) {
  return {
    id: schedule.id,
    scopeId: schedule.scopeId,
    threadRef: schedule.threadRef,
    cron: schedule.cron,
    timezone: schedule.timezone,
    prompt: schedule.prompt,
    toolAllowlist: schedule.toolAllowlist,
    status: schedule.status,
    createdById: schedule.createdById,
    activatedById: schedule.activatedById,
    lastFiredAt: schedule.lastFiredAt?.toISOString() ?? null,
    skippedCount: schedule.skippedCount,
  };
}

function throwScheduleError(error: unknown): never {
  if (error instanceof CronParseError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof ScheduleStatusError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  throw error;
}

const scopeIdFromInput = (input: unknown): string | undefined =>
  typeof input === "object" && input !== null && "scopeId" in input
    ? ((input as { scopeId?: string }).scopeId ?? undefined)
    : undefined;

const create = requireCapability("manage_schedules", { scopeId: scopeIdFromInput })
  .route({
    method: "POST",
    path: "/schedules",
    summary: "Create a schedule",
    description: [
      "Create a standing schedule for a scope. A schedule an agent proposes stays `proposed`",
      "until a person with an approver-grade role activates it, because an active schedule is",
      "standing authority to act with the scope's credentials unattended.",
    ].join(" "),
    tags: ["Schedules"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The scope the firings belong to. A UUID."),
        cron: z.string().trim().min(1).describe("A five-field cron expression."),
        timezone: z.string().trim().min(1).describe("An IANA time zone, such as `Europe/Paris`."),
        prompt: z.string().trim().min(1).describe("The message each firing starts with."),
        toolAllowlist: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Narrows the session's resolved tools. It can never widen them."),
        status: z
          .enum(["proposed", "active"])
          .optional()
          .describe("Create it active to start ticking immediately. It defaults to `proposed`."),
      })
      .describe("The standing configuration to create."),
  )
  .output(scheduleSchema)
  .handler(async ({ context, input }) => {
    try {
      return serialize(
        await createSchedule(context.db, {
          orgId: context.org.id,
          scopeId: input.scopeId,
          cron: input.cron,
          timezone: input.timezone,
          prompt: input.prompt,
          createdById: context.principal.id,
          ...(input.toolAllowlist === undefined ? {} : { toolAllowlist: input.toolAllowlist }),
          ...(input.status === undefined ? {} : { status: input.status }),
          ...(input.status === "active" ? { activatedById: context.principal.id } : {}),
        }),
      );
    } catch (error) {
      throwScheduleError(error);
    }
  });

const list = requireCapability("read", { scopeId: scopeIdFromInput })
  .route({
    method: "GET",
    path: "/schedules",
    summary: "List schedules",
    description: "List the organization's schedules, optionally filtered by scope and status.",
    tags: ["Schedules"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().optional().describe("Only list schedules for this scope."),
        status: statusSchema.optional(),
      })
      .describe("Optional filters."),
  )
  .output(z.object({ schedules: z.array(scheduleSchema) }).describe("The matching schedules."))
  .handler(async ({ context, input }) => {
    const schedules = await listSchedules(context.db, {
      orgId: context.org.id,
      ...(input.scopeId === undefined ? {} : { scopeId: input.scopeId }),
      ...(input.status === undefined ? {} : { status: input.status }),
    });
    // Personal scopes do not inherit org roles, so an org-wide listing must
    // check each scope the results came from rather than the org scope alone.
    const readable = new Map<string, boolean>();
    for (const scopeId of new Set(schedules.map((schedule) => schedule.scopeId))) {
      readable.set(scopeId, await authorize(context.principal, "read", scopeId, context.db));
    }
    return {
      schedules: schedules
        .filter((schedule) => readable.get(schedule.scopeId) === true)
        .map(serialize),
    };
  });

/**
 * Loads the schedule and authorizes the capability against its own scope.
 * Personal scopes do not inherit org roles, so the org scope must not stand in.
 * @throws {ORPCError} NOT_FOUND for an unknown schedule, FORBIDDEN otherwise.
 */
async function requireManageableSchedule(
  context: { db: Database; org: { id: string }; principal: AuthorizePrincipal },
  scheduleId: string,
): Promise<Schedule> {
  let schedule: Schedule;
  try {
    schedule = await requireSchedule(context.db, context.org.id, scheduleId);
  } catch {
    throw new ORPCError("NOT_FOUND", { message: "Schedule not found" });
  }
  if (!(await authorize(context.principal, "manage_schedules", schedule.scopeId, context.db))) {
    throw new ORPCError("FORBIDDEN", { message: "Capability required: manage_schedules" });
  }
  return schedule;
}

const update = orgScoped
  .route({
    method: "PATCH",
    path: "/schedules/{id}",
    summary: "Edit a schedule",
    description: "Change a schedule's expression, time zone, prompt, or tool allowlist.",
    tags: ["Schedules"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The schedule's ID. A UUID."),
        cron: z.string().trim().min(1).optional().describe("A five-field cron expression."),
        timezone: z.string().trim().min(1).optional().describe("An IANA time zone."),
        prompt: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The message each firing starts with."),
        toolAllowlist: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Narrows the session's resolved tools."),
      })
      .describe("The fields to change."),
  )
  .output(scheduleSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireManageableSchedule(context, input.id);
      return serialize(
        await updateSchedule(context.db, {
          orgId: context.org.id,
          scheduleId: input.id,
          ...(input.cron === undefined ? {} : { cron: input.cron }),
          ...(input.timezone === undefined ? {} : { timezone: input.timezone }),
          ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
          ...(input.toolAllowlist === undefined ? {} : { toolAllowlist: input.toolAllowlist }),
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("unknown schedule")) {
        throw new ORPCError("NOT_FOUND", { message: "Schedule not found" });
      }
      throwScheduleError(error);
    }
  });

const setStatus = orgScoped
  .route({
    method: "POST",
    path: "/schedules/{id}/status",
    summary: "Change a schedule's status",
    description: [
      "Activate, pause, or archive a schedule. Activation records the principal who took",
      "responsibility for it. A pause stops ticks immediately and leaves runs that earlier",
      "firings started to complete, park, or expire under the normal rules.",
    ].join(" "),
    tags: ["Schedules"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The schedule's ID. A UUID."),
        status: statusSchema,
      })
      .describe("The status to move to."),
  )
  .output(scheduleSchema)
  .handler(async ({ context, input }) => {
    try {
      await requireManageableSchedule(context, input.id);
      return serialize(
        await setScheduleStatus(context.db, {
          orgId: context.org.id,
          scheduleId: input.id,
          status: input.status,
          byPrincipalId: context.principal.id,
        }),
      );
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("unknown schedule")) {
        throw new ORPCError("NOT_FOUND", { message: "Schedule not found" });
      }
      throwScheduleError(error);
    }
  });

export const schedulesRouter = { create, list, update, setStatus };
