import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { orgScoped } from "#/rpc/builders.js";
import { itemKindSchema } from "#/rpc/items.js";
import { authorize } from "#/services/authorize/index.js";
import { searchItems } from "#/services/search/index.js";

const resultSchema = z
  .object({
    id: z.string().describe("The matching item's unique ID. A UUID (version 7)."),
    kind: itemKindSchema.describe("The matching item's kind."),
    title: z.string().describe("The matching item's title."),
    snippet: z.string().describe("A bounded excerpt of the matching body text, as plain text."),
    score: z.number().describe("The full-text rank. Higher scores match better."),
  })
  .describe("One full-text item match. The item body is never included.");

const items = orgScoped
  .route({
    method: "GET",
    path: "/items/search",
    summary: "Search items",
    description:
      "Rank active items in the requested scopes against a full-text query. Titles outrank bodies. Results carry an excerpt, never the item body.",
    tags: ["Items"],
  })
  .input(
    z
      .object({
        query: z.string().describe("The search query. Supports web-search operators."),
        scopeIds: z
          .array(z.uuid())
          .max(100)
          .describe("The scopes to search. Each must be readable by the caller."),
        limit: z
          .number()
          .int()
          .positive()
          .max(50)
          .optional()
          .describe("The maximum number of results. Defaults to 20 and caps at 50."),
      })
      .describe("The item search request."),
  )
  .output(z.array(resultSchema).describe("The ranked matches, best first."))
  .handler(async ({ context, input }) => {
    for (const scopeId of input.scopeIds) {
      if (!(await authorize(context.principal, "read", scopeId, context.db))) {
        throw new ORPCError("FORBIDDEN", { message: "Capability required: read" });
      }
    }
    return searchItems(context.db, {
      orgId: context.org.id,
      scopeIds: input.scopeIds,
      query: input.query,
      ...(input.limit !== undefined ? { limit: input.limit } : {}),
    });
  });

export const searchRouter = { items };
