import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  createSpace,
  getScope,
  listScopes,
  renameSpace,
  ScopeNotFoundError,
  ScopeNotRenameableError,
} from "#/services/scopes/index.js";
import { requireCapability } from "./builders.js";

const scopeKindSchema = z
  .enum(["org", "space", "personal"])
  .describe("The scope kind: `org`, `space`, or `personal`.");

const scopeSchema = z
  .object({
    id: z.string().describe("The scope's unique ID. A UUID (version 7)."),
    kind: scopeKindSchema.describe("The scope's kind."),
    name: z.string().describe("The scope's display name."),
    ownerId: z
      .string()
      .nullable()
      .describe("The owning human principal's ID for a personal scope; otherwise null."),
  })
  .describe("A context scope in the active organization.");

const create = requireCapability("manage_spaces")
  .route({
    method: "POST",
    path: "/scopes",
    summary: "Create a space",
    description: "Create a shared space scope in the active organization.",
    tags: ["Scopes"],
  })
  .input(
    z
      .object({
        name: z.string().trim().min(1).describe("A display name for the space. Cannot be empty."),
      })
      .describe("The space to create."),
  )
  .output(scopeSchema)
  .handler(({ context, input }) =>
    createSpace(context.db, {
      orgId: context.org.id,
      actorPrincipalId: context.principal.id,
      name: input.name,
    }),
  );

const list = requireCapability("read")
  .route({
    method: "GET",
    path: "/scopes",
    summary: "List scopes",
    description: "List scopes in the active organization, optionally filtered by kind.",
    tags: ["Scopes"],
  })
  .input(
    z
      .object({
        kind: scopeKindSchema.optional().describe("Only return scopes of this kind when provided."),
      })
      .describe("Optional scope-list filters."),
  )
  .output(z.array(scopeSchema).describe("The active organization's scopes."))
  .handler(({ context, input }) => listScopes(context.db, context.org.id, input.kind));

const get = requireCapability("read")
  .route({
    method: "GET",
    path: "/scopes/{id}",
    summary: "Get a scope",
    description: "Get one scope in the active organization.",
    tags: ["Scopes"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The ID of the scope to fetch. A UUID."),
      })
      .describe("The scope to fetch."),
  )
  .output(scopeSchema)
  .handler(async ({ context, input }) => {
    try {
      return await getScope(context.db, context.org.id, input.id);
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const rename = requireCapability("manage_spaces")
  .route({
    method: "PATCH",
    path: "/scopes/{id}",
    summary: "Rename a space",
    description: "Rename a space scope. Organization and personal scopes cannot be renamed.",
    tags: ["Scopes"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The ID of the space to rename. A UUID."),
        name: z.string().trim().min(1).describe("The space's new name. Cannot be empty."),
      })
      .describe("The space rename."),
  )
  .output(scopeSchema)
  .handler(async ({ context, input }) => {
    try {
      return await renameSpace(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        scopeId: input.id,
        name: input.name,
      });
    } catch (error) {
      if (error instanceof ScopeNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      if (error instanceof ScopeNotRenameableError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    }
  });

// Scope lifecycle, including deletion, belongs to a later implementation phase.
export const scopesRouter = { create, list, get, rename };
