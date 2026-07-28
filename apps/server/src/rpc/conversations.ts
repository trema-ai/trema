import { z } from "zod";

import { orgScoped } from "#server/rpc/builders.js";
import {
  CONVERSATION_LIST_LIMIT,
  listConversations,
} from "#server/services/conversations/index.js";

const conversationSchema = z
  .object({
    id: z.string().describe("The conversation's unique ID. A UUID (version 7)."),
    surface: z.string().describe("The integration surface the thread happened on."),
    locationRef: z.string().describe("The surface-specific location the thread lives at."),
    threadRef: z
      .string()
      .describe("The thread's surface identifier. Empty for a surface without threads."),
    startedAt: z.string().describe("When the thread started. An ISO 8601 date-time."),
    lastActivityAt: z
      .string()
      .describe("When the thread last saw a message. An ISO 8601 date-time."),
    firstMessageText: z
      .string()
      .nullable()
      .describe("The earliest captured message's text — the title until digests exist."),
  })
  .describe("One captured thread of the caller's own.");

const list = orgScoped
  .route({
    method: "GET",
    path: "/conversations",
    summary: "List your conversations",
    description:
      "The caller's own conversation list — the threads captured in their personal scope, newest activity first. Owner-scoped by construction: nobody's conversations but the caller's ever appear, whatever their role.",
    tags: ["Conversations"],
  })
  .input(
    z
      .object({
        surface: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("Only list this surface's conversations, e.g. `web`."),
        limit: z
          .number()
          .int()
          .min(1)
          .max(200)
          .optional()
          .describe(`How many conversations to return. Defaults to ${CONVERSATION_LIST_LIMIT}.`),
      })
      .describe("Optional conversation-list filters."),
  )
  .output(
    z
      .object({ conversations: z.array(conversationSchema) })
      .describe("The caller's conversations, newest activity first."),
  )
  .handler(async ({ context, input }) => {
    // The list is owner-scoped, not an admin browse: the one scope it reads is
    // the caller's own personal scope. A member without one has no
    // conversations, which an empty list says plainly.
    const personalScope = await context.db.scope.findFirst({
      where: { orgId: context.org.id, kind: "personal", ownerId: context.principal.id },
      select: { id: true },
    });
    if (personalScope === null) return { conversations: [] };

    const conversations = await listConversations(context.db, {
      orgId: context.org.id,
      scopeId: personalScope.id,
      ...(input.surface === undefined ? {} : { surface: input.surface }),
      ...(input.limit === undefined ? {} : { limit: input.limit }),
    });
    return {
      conversations: conversations.map((conversation) => ({
        id: conversation.id,
        surface: conversation.surface,
        locationRef: conversation.locationRef,
        threadRef: conversation.threadRef,
        startedAt: conversation.startedAt.toISOString(),
        lastActivityAt: conversation.lastActivityAt.toISOString(),
        firstMessageText: conversation.firstMessageText,
      })),
    };
  });

export const conversationsRouter = { list };
