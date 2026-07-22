import { ORPCError } from "@orpc/server";
import { z } from "zod";

import type { Item } from "#/generated/prisma/client.js";
import { orgScoped, requireCapability } from "#/rpc/builders.js";
import { authorize, type Capability } from "#/services/authorize/index.js";
import {
  activateItem,
  archiveItem,
  createItem,
  getItem,
  ItemNotFoundError,
  ItemValidationError,
  listItems,
  restoreItem,
  updateItem,
} from "#/services/items/index.js";

const itemKindSchema = z
  .enum(["memory", "skill", "instruction", "connector", "conversation"])
  .describe("The item kind.");
const itemStatusSchema = z
  .enum(["proposed", "active", "archived"])
  .describe("The item's lifecycle status.");
const itemDisclosureSchema = z
  .enum(["standing", "retrieved"])
  .describe("Whether the item is injected into sessions or retrieved on demand.");
const itemBodySchema = z.json().describe("The kind-specific item body.");

const itemSchema = z
  .object({
    id: z.string().describe("The item's unique ID. A UUID (version 7)."),
    scopeId: z.string().describe("The ID of the item's single context scope."),
    kind: itemKindSchema,
    title: z.string().describe("The short title used as a retrieval key."),
    body: itemBodySchema,
    status: itemStatusSchema,
    disclosure: itemDisclosureSchema,
    createdById: z.string().describe("The principal that created the item."),
    sourceSessionId: z
      .string()
      .nullable()
      .describe("The source session for an agent-authored item, when present."),
    confirmedById: z
      .string()
      .nullable()
      .describe("The human principal that activated a proposed item, when present."),
    createdAt: z.string().describe("When the item was created. An ISO 8601 date-time."),
    updatedAt: z.string().describe("When the item was last updated. An ISO 8601 date-time."),
    lastUsedAt: z
      .string()
      .nullable()
      .describe("When a session last used the item, when known. An ISO 8601 date-time."),
    version: z.number().int().positive().describe("The item's monotonic content version."),
  })
  .describe("A versioned context item in exactly one scope.");

function serializeItem(item: Item) {
  return {
    id: item.id,
    scopeId: item.scopeId,
    kind: item.kind,
    title: item.title,
    body: item.body as z.infer<typeof itemBodySchema>,
    status: item.status,
    disclosure: item.disclosure,
    createdById: item.createdById,
    sourceSessionId: item.sourceSessionId,
    confirmedById: item.confirmedById,
    createdAt: item.createdAt.toISOString(),
    updatedAt: item.updatedAt.toISOString(),
    lastUsedAt: item.lastUsedAt?.toISOString() ?? null,
    version: item.version,
  };
}

function throwItemError(error: unknown): never {
  if (error instanceof ItemNotFoundError) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof ItemValidationError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  throw error;
}

function itemScoped(capability: Capability) {
  return orgScoped.use(async ({ context, next }, input) => {
    const itemId = (input as { id?: unknown }).id;
    if (typeof itemId !== "string") {
      throw new ORPCError("BAD_REQUEST", { message: "Item ID is required" });
    }
    const item = await context.db.item.findFirst({
      where: { id: itemId, orgId: context.org.id },
      select: { scopeId: true },
    });
    if (!item) throw new ORPCError("NOT_FOUND", { message: "Item not found" });
    if (!(await authorize(context.principal, capability, item.scopeId, context.db))) {
      throw new ORPCError("FORBIDDEN", { message: `Capability required: ${capability}` });
    }
    return next({ context: { authorizedScopeId: item.scopeId } });
  });
}

const create = requireCapability("write_items", {
  scopeId: (input) => (input as { scopeId?: string }).scopeId,
})
  .route({
    method: "POST",
    path: "/items",
    summary: "Create an item",
    description:
      "Create a memory or instruction in one scope. Other item kinds arrive in later phases.",
    tags: ["Items"],
  })
  .input(
    z
      .object({
        scopeId: z.uuid().describe("The ID of the item's single context scope. A UUID."),
        kind: itemKindSchema,
        title: z.string().trim().min(1).describe("The item's short retrieval title."),
        body: itemBodySchema,
        status: itemStatusSchema
          .optional()
          .describe("A requested status. The writer policy determines the stored status."),
        disclosure: itemDisclosureSchema
          .optional()
          .describe(
            "An explicit disclosure override. Otherwise the kind-specific default applies.",
          ),
        sourceSessionId: z
          .string()
          .trim()
          .min(1)
          .optional()
          .describe("The source session ID for agent-authored provenance, when present."),
      })
      .describe("The item to create."),
  )
  .output(itemSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeItem(
        await createItem(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          scopeId: input.scopeId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          ...(input.status !== undefined ? { status: input.status } : {}),
          ...(input.disclosure !== undefined ? { disclosure: input.disclosure } : {}),
          ...(input.sourceSessionId !== undefined
            ? { sourceSessionId: input.sourceSessionId }
            : {}),
        }),
      );
    } catch (error) {
      throwItemError(error);
    }
  });

const list = orgScoped
  .route({
    method: "GET",
    path: "/items",
    summary: "List items",
    description:
      "List authorized items in the active organization with optional kind, status, and scope filters.",
    tags: ["Items"],
  })
  .input(
    z
      .object({
        kind: itemKindSchema.optional().describe("Only return items of this kind."),
        status: itemStatusSchema.optional().describe("Only return items with this status."),
        scopeId: z.uuid().optional().describe("Only return items in this scope. A UUID."),
      })
      .describe("Optional item-list filters."),
  )
  .output(z.array(itemSchema).describe("Items readable by the acting principal."))
  .handler(async ({ context, input }) => {
    if (input.scopeId && !(await authorize(context.principal, "read", input.scopeId, context.db))) {
      throw new ORPCError("FORBIDDEN", { message: "Capability required: read" });
    }
    const items = await listItems(context.db, {
      orgId: context.org.id,
      ...(input.kind !== undefined ? { kind: input.kind } : {}),
      ...(input.status !== undefined ? { status: input.status } : {}),
      ...(input.scopeId !== undefined ? { scopeId: input.scopeId } : {}),
    });
    if (input.scopeId) return items.map(serializeItem);

    const readable = new Map<string, boolean>();
    for (const scopeId of new Set(items.map((item) => item.scopeId))) {
      readable.set(scopeId, await authorize(context.principal, "read", scopeId, context.db));
    }
    return items.filter((item) => readable.get(item.scopeId)).map(serializeItem);
  });

const get = itemScoped("read")
  .route({
    method: "GET",
    path: "/items/{id}",
    summary: "Get an item",
    description: "Get one authorized item in the active organization.",
    tags: ["Items"],
  })
  .input(z.object({ id: z.uuid().describe("The ID of the item to fetch. A UUID.") }))
  .output(itemSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeItem(await getItem(context.db, context.org.id, input.id));
    } catch (error) {
      throwItemError(error);
    }
  });

const updateInput = z
  .object({
    id: z.uuid().describe("The ID of the item to update. A UUID."),
    title: z.string().trim().min(1).optional().describe("A replacement retrieval title."),
    body: itemBodySchema.optional().describe("A replacement kind-specific body."),
    disclosure: itemDisclosureSchema.optional().describe("A replacement disclosure tier."),
  })
  .refine(
    (input) =>
      input.title !== undefined || input.body !== undefined || input.disclosure !== undefined,
    { message: "At least one editable field is required" },
  )
  .describe("The item fields to update.");

const update = itemScoped("write_items")
  .route({
    method: "PATCH",
    path: "/items/{id}",
    summary: "Update an item",
    description:
      "Update an item's title, body, or disclosure. Content changes retain the prior version.",
    tags: ["Items"],
  })
  .input(updateInput)
  .output(itemSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeItem(
        await updateItem(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          itemId: input.id,
          ...(input.title !== undefined ? { title: input.title } : {}),
          ...(input.body !== undefined ? { body: input.body } : {}),
          ...(input.disclosure !== undefined ? { disclosure: input.disclosure } : {}),
        }),
      );
    } catch (error) {
      throwItemError(error);
    }
  });

function lifecycleRoute(action: "activate" | "archive" | "restore") {
  const operation = { activate: activateItem, archive: archiveItem, restore: restoreItem }[action];
  return itemScoped("write_items")
    .route({
      method: "POST",
      path: `/items/{id}/${action}`,
      summary: `${action[0]!.toUpperCase()}${action.slice(1)} an item`,
      description: `Apply the '${action}' lifecycle transition to an item.`,
      tags: ["Items"],
    })
    .input(z.object({ id: z.uuid().describe(`The ID of the item to ${action}. A UUID.`) }))
    .output(itemSchema)
    .handler(async ({ context, input }) => {
      try {
        return serializeItem(
          await operation(context.db, {
            orgId: context.org.id,
            actorPrincipalId: context.principal.id,
            itemId: input.id,
          }),
        );
      } catch (error) {
        throwItemError(error);
      }
    });
}

export const itemsRouter = {
  create,
  list,
  get,
  update,
  activate: lifecycleRoute("activate"),
  archive: lifecycleRoute("archive"),
  restore: lifecycleRoute("restore"),
};
