import { ORPCError } from "@orpc/server";
import type { Engine } from "@trema/harness";
import { z } from "zod";

import type { Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";
import { log } from "#/lib/logger/index.js";
import { serviceAuthed } from "#/rpc/builders.js";
import { createRunServices, type RunServices, startRun } from "#/services/runs/index.js";
import {
  SessionClosedError,
  SessionResolutionError,
  SessionValidationError,
} from "#/services/sessions/index.js";

/** The request context fields the run services need. */
export interface RunServicesContext {
  db: Database;
  env: Environment;
  runEngine?: Engine;
}

/**
 * Builds the run services for the calling organization.
 * @throws {ORPCError} When the deployment has no run engine configured.
 */
export function runServicesFor(context: RunServicesContext, orgId: string): RunServices {
  if (context.runEngine === undefined) {
    log.error("Run engine is not configured");
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "This deployment cannot schedule runs",
    });
  }
  return createRunServices({
    db: context.db,
    env: context.env,
    orgId,
    engine: context.runEngine,
  });
}

const messageSchema = z
  .string()
  .trim()
  .min(1)
  .describe("The message the run starts from, or the steering it adds to an active run.");

const create = serviceAuthed
  .route({
    method: "POST",
    path: "/runs",
    successStatus: 202,
    summary: "Start a run",
    description: [
      "Enter a message into the thread's dispatch, exactly as a chat surface would.",
      "An active run on the thread absorbs the message; otherwise a new run starts.",
      "The response reports where the message landed and never waits for execution:",
      "observe progress through the run's event stream.",
    ].join(" "),
    tags: ["Runs"],
  })
  .input(
    z
      .object({
        locationRef: z
          .string()
          .trim()
          .min(1)
          .describe("The surface-specific location identifier. It must be bound to a scope."),
        surface: z
          .string()
          .trim()
          .min(1)
          .default("api")
          .describe("The integration surface the location belongs to."),
        threadRef: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The thread to join. It defaults to the surface and location."),
        message: messageSchema,
        idempotencyKey: z
          .string()
          .trim()
          .min(1)
          .describe("Retry the same call with the same key to reach the same run exactly once."),
      })
      .describe("Where the message goes and what it says."),
  )
  .output(
    z
      .object({
        runId: z
          .string()
          .nullable()
          .describe("The run the message landed on. Null when a duplicate call is still routing."),
        outcome: z
          .enum(["started", "steered", "duplicate"])
          .describe(
            "`started` created a run, `steered` added the message to the active run, `duplicate` repeated a used key.",
          ),
        threadRef: z.string().describe("The thread the message landed on."),
      })
      .describe("Where the message landed."),
  )
  .handler(async ({ context, input }) => {
    const services = runServicesFor(context, context.org.id);
    try {
      return await startRun({
        services,
        input: {
          idempotencyKey: input.idempotencyKey,
          trigger: "api",
          surface: input.surface,
          locationRef: input.locationRef,
          // A credential bound to the organization's agent is nobody asking, so
          // the session opens in service mode with no requester.
          ...(context.principal.kind === "human"
            ? { requester: { principalId: context.principal.id } }
            : {}),
          message: { role: "user", blocks: [{ type: "text", text: input.message }] },
          author: { principalId: context.principal.id, displayName: context.principal.displayName },
          ...(input.threadRef === undefined ? {} : { threadRef: input.threadRef }),
        },
      });
    } catch (error) {
      if (error instanceof SessionResolutionError) {
        // An unbound location is the same structured error a surface would get.
        throw new ORPCError(error.code === "location_unbound" ? "NOT_FOUND" : "FORBIDDEN", {
          message: error.message,
          data: { code: error.code, ...error.detail },
        });
      }
      if (error instanceof SessionValidationError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      if (error instanceof SessionClosedError) {
        throw new ORPCError("CONFLICT", { message: error.message, data: { code: error.code } });
      }
      throw error;
    }
  });

export const runsRouter = { create };
