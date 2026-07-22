import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  createSharedScope,
  getPersonalPolicy,
  getScope,
  listScopes,
  renameSharedScope,
  ScopeNotFoundError,
  ScopeNotRenameableError,
  setPersonalPolicy,
} from "#/services/scopes/index.js";
import { requireCapability } from "./builders.js";

const scopeKindSchema = z
  .enum(["org", "shared", "personal"])
  .describe("The scope kind: `org`, `shared`, or `personal`.");

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

const create = requireCapability("manage_scopes")
  .route({
    method: "POST",
    path: "/scopes",
    summary: "Create a shared scope",
    description: "Create a shared scope in the active organization.",
    tags: ["Scopes"],
  })
  .input(
    z
      .object({
        name: z.string().trim().min(1).describe("A display name for the scope. Cannot be empty."),
      })
      .describe("The shared scope to create."),
  )
  .output(scopeSchema)
  .handler(({ context, input }) =>
    createSharedScope(context.db, {
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

const rename = requireCapability("manage_scopes")
  .route({
    method: "PATCH",
    path: "/scopes/{id}",
    summary: "Rename a shared scope",
    description: "Rename a shared scope. Organization and personal scopes cannot be renamed.",
    tags: ["Scopes"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The ID of the shared scope to rename. A UUID."),
        name: z.string().trim().min(1).describe("The scope's new name. Cannot be empty."),
      })
      .describe("The shared scope rename."),
  )
  .output(scopeSchema)
  .handler(async ({ context, input }) => {
    try {
      return await renameSharedScope(context.db, {
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

const personalPolicySchema = z
  .object({
    enabled: z
      .boolean()
      .describe("Whether direct messages create and resolve personal scopes in this organization."),
  })
  .describe("The organization's personal-scope policy.");

const personalPolicy = requireCapability("read")
  .route({
    method: "GET",
    path: "/scopes/personal-policy",
    summary: "Get the personal-scope policy",
    description: "Whether direct messages create and resolve personal scopes.",
    tags: ["Scopes"],
  })
  .output(personalPolicySchema)
  .handler(({ context }) => getPersonalPolicy(context.db, context.org.id));

const setPersonalPolicyRoute = requireCapability("manage_scopes")
  .route({
    method: "PATCH",
    path: "/scopes/personal-policy",
    summary: "Set the personal-scope policy",
    description:
      "Enable or disable personal scopes for the organization. Disabling stops direct messages from creating or resolving personal scopes; existing scopes and their items are kept and become reachable again when re-enabled.",
    tags: ["Scopes"],
  })
  .input(personalPolicySchema)
  .output(personalPolicySchema)
  .handler(({ context, input }) =>
    setPersonalPolicy(context.db, {
      orgId: context.org.id,
      actorPrincipalId: context.principal.id,
      enabled: input.enabled,
    }),
  );

// Scope lifecycle, including deletion, belongs to a later implementation phase.
export const scopesRouter = {
  create,
  list,
  get,
  rename,
  personalPolicy,
  setPersonalPolicy: setPersonalPolicyRoute,
};
