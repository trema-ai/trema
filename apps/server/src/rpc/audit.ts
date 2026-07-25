import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  AUDIT_MAX_PAGE_SIZE,
  AUDIT_PAGE_SIZE,
  listAuditActions,
  listAuditEntries,
} from "#server/services/audit/index.js";
import { requireCapability } from "./builders.js";

const auditActorSchema = z
  .object({
    id: z.string().describe("The acting principal's ID. A UUID (version 7)."),
    displayName: z.string().describe("The name shown for the acting principal."),
    kind: z.enum(["human", "agent"]).describe("Whether a person or the agent acted."),
  })
  .nullable()
  .describe("The principal that performed the action. Null when the system acted on its own.");

const auditEntrySchema = z
  .object({
    id: z.string().describe("The entry's unique ID. A UUID (version 7)."),
    action: z
      .string()
      .describe(
        "The recorded action, such as `grant.set_role` or `connector.installation.create`.",
      ),
    subject: z.string().describe("The ID of the record the action changed."),
    actor: auditActorSchema,
    payload: z.json().describe("The action-specific details recorded with the entry."),
    createdAt: z.string().describe("When the action happened. An ISO 8601 date-time."),
  })
  .describe("One entry in the organization's audit log.");

const timestampSchema = z.iso.datetime().transform((value) => new Date(value));

const list = requireCapability("read_audit")
  .route({
    method: "GET",
    path: "/audit",
    summary: "List audit log entries",
    description:
      "List the active organization's audit log entries, newest first. Pass the returned cursor to read the next page.",
    tags: ["Audit"],
  })
  .input(
    z
      .object({
        action: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Only return entries whose action matches this value exactly."),
        actionPrefix: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Only return entries whose action starts with this value, such as `invite.`."),
        actorPrincipalId: z
          .uuid()
          .optional()
          .describe("Only return entries recorded for this acting principal. A UUID."),
        from: timestampSchema
          .optional()
          .describe("Only return entries recorded at or after this time. An ISO 8601 date-time."),
        to: timestampSchema
          .optional()
          .describe("Only return entries recorded at or before this time. An ISO 8601 date-time."),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(AUDIT_MAX_PAGE_SIZE)
          .optional()
          .describe(`How many entries to return. Defaults to ${AUDIT_PAGE_SIZE}.`),
        cursor: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The `nextCursor` of the previous page. Omit for the first page."),
      })
      .describe("Optional audit-log filters and the page to read."),
  )
  .output(
    z
      .object({
        entries: z.array(auditEntrySchema).describe("The page of entries, newest first."),
        nextCursor: z
          .string()
          .nullable()
          .describe("The cursor for the next page, or null when this is the last page."),
      })
      .describe("A page of audit log entries."),
  )
  .handler(async ({ context, input }) => {
    if (input.from && input.to && input.from > input.to) {
      throw new ORPCError("BAD_REQUEST", {
        message: "Audit range start must be before its end",
      });
    }

    const { entries, nextCursor } = await listAuditEntries(context.db, {
      orgId: context.org.id,
      ...(input.action !== undefined ? { action: input.action } : {}),
      ...(input.actionPrefix !== undefined ? { actionPrefix: input.actionPrefix } : {}),
      ...(input.actorPrincipalId !== undefined ? { actorPrincipalId: input.actorPrincipalId } : {}),
      ...(input.from !== undefined ? { from: input.from } : {}),
      ...(input.to !== undefined ? { to: input.to } : {}),
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
      ...(input.cursor !== undefined ? { cursor: input.cursor } : {}),
    });

    return {
      entries: entries.map((entry) => ({
        id: entry.id,
        action: entry.action,
        subject: entry.subject,
        actor: entry.actor,
        payload: entry.payload as z.infer<typeof auditEntrySchema>["payload"],
        createdAt: entry.createdAt.toISOString(),
      })),
      nextCursor,
    };
  });

const actions = requireCapability("read_audit")
  .route({
    method: "GET",
    path: "/audit/actions",
    summary: "List audit log actions",
    description:
      "List the distinct actions present in the active organization's audit log, so a client can offer them as filters.",
    tags: ["Audit"],
  })
  .output(z.array(z.string()).describe("The distinct actions, in alphabetical order."))
  .handler(({ context }) => listAuditActions(context.db, context.org.id));

export const auditRouter = { list, actions };
