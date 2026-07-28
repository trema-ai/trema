import { ORPCError } from "@orpc/server";
import type { Engine } from "@trema/harness";
import { z } from "zod";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import { serviceAuthed } from "#server/rpc/builders.js";
import { createRunServices, type RunServices, startRun } from "#server/services/runs/index.js";
import {
  SessionClosedError,
  SessionResolutionError,
  SessionValidationError,
} from "#server/services/sessions/index.js";

/** The request context fields the run services need. */
export interface RunServicesContext {
  db: Database;
  env: Environment;
  runEngineFor?: (orgId: string) => Engine;
}

/**
 * Builds the run services for the calling organization.
 * @throws {ORPCError} When the deployment has no run engine configured.
 */
export function runServicesFor(context: RunServicesContext, orgId: string): RunServices {
  if (context.runEngineFor === undefined) {
    log.error("Run engine is not configured");
    throw new ORPCError("SERVICE_UNAVAILABLE", {
      message: "This deployment cannot schedule runs",
    });
  }
  return createRunServices({
    db: context.db,
    env: context.env,
    orgId,
    engine: context.runEngineFor(orgId),
  });
}

// One member today. Decisions on a run — resolve, stop, retry, feedback — join
// this union as the surfaces that submit them land.
const intentSchema = z
  .discriminatedUnion("type", [
    z
      .object({
        type: z.literal("message").describe("Says something to the agent on the thread."),
        text: z.string().trim().min(1).describe("What the message says."),
      })
      .describe("A message for the thread."),
  ])
  .describe("What the caller is doing.");

const submit = serviceAuthed
  .route({
    method: "POST",
    path: "/intents",
    successStatus: 202,
    summary: "Submit an intent",
    description: [
      "Enter an intent into the thread's dispatch, exactly as a chat surface would.",
      "A message lands on the thread: an active run absorbs it, otherwise a new run starts.",
      "The response reports where the intent landed and never waits for execution:",
      "observe progress through the run's event stream.",
    ].join(" "),
    tags: ["Intents"],
  })
  .input(
    z
      .object({
        intentId: z
          .string()
          .trim()
          .min(1)
          .describe("Retry the same call with the same id to reach the same run exactly once."),
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
        intent: intentSchema,
      })
      .describe("Where the intent goes and what it asks for."),
  )
  .output(
    z
      .object({
        runId: z
          .string()
          .nullable()
          .describe("The run the intent landed on. Null when a duplicate call is still routing."),
        outcome: z
          .enum(["started", "steered", "follow-up", "duplicate"])
          .describe(
            "`started` created a run, `steered` added the message to the active run, `follow-up` queued it behind a run that is finishing, `duplicate` repeated a used id.",
          ),
        threadRef: z.string().describe("The thread the intent landed on."),
      })
      .describe("Where the intent landed."),
  )
  .handler(async ({ context, input }) => {
    const services = runServicesFor(context, context.org.id);
    try {
      return await startRun({
        services,
        input: {
          intentId: input.intentId,
          trigger: "api",
          surface: input.surface,
          locationRef: input.locationRef,
          // A credential bound to the organization's agent is nobody asking, so
          // the session opens in service mode with no requester.
          ...(context.principal.kind === "human"
            ? { requester: { principalId: context.principal.id } }
            : {}),
          message: { role: "user", blocks: [{ type: "text", text: input.intent.text }] },
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

export const intentsRouter = { submit };
