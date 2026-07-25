import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  BindingConflictError,
  BindingNotFoundError,
  BindingTargetError,
  createBinding,
  deleteBinding,
  listBindings,
  UnknownSurfaceError,
} from "#server/services/bindings/index.js";
import { requireCapability } from "./builders.js";

const bindingSchema = z
  .object({
    id: z.string().describe("The binding's unique ID. A UUID (version 7)."),
    surface: z.string().describe("The integration surface, such as `slack` or `email`."),
    locationRef: z.string().describe("The surface-specific location identifier."),
    scopeId: z
      .string()
      .describe("The ID of the organization or shared scope this location resolves to."),
    createdAt: z.string().describe("When the binding was created. An ISO 8601 date-time."),
    updatedAt: z.string().describe("When the binding was last updated. An ISO 8601 date-time."),
  })
  .describe("A surface location bound to a context scope.");

function serializeBinding(binding: {
  id: string;
  surface: string;
  locationRef: string;
  scopeId: string;
  createdAt: Date;
  updatedAt: Date;
}) {
  return {
    id: binding.id,
    surface: binding.surface,
    locationRef: binding.locationRef,
    scopeId: binding.scopeId,
    createdAt: binding.createdAt.toISOString(),
    updatedAt: binding.updatedAt.toISOString(),
  };
}

const create = requireCapability("manage_scopes")
  .route({
    method: "POST",
    path: "/bindings",
    summary: "Create a surface binding",
    description: "Bind a surface location to an organization or shared scope.",
    tags: ["Bindings"],
  })
  .input(
    z
      .object({
        surface: z.string().trim().min(1).describe("The interface surface. Cannot be empty."),
        locationRef: z
          .string()
          .trim()
          .min(1)
          .describe("The surface-specific location identifier. Cannot be empty."),
        scopeId: z.uuid().describe("The ID of the organization or shared scope to bind. A UUID."),
      })
      .describe("The surface binding to create."),
  )
  .output(bindingSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeBinding(
        await createBinding(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          ...input,
        }),
      );
    } catch (error) {
      if (error instanceof BindingConflictError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      if (error instanceof BindingNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      if (error instanceof BindingTargetError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      if (error instanceof UnknownSurfaceError) {
        throw new ORPCError("BAD_REQUEST", { message: error.message });
      }
      throw error;
    }
  });

const list = requireCapability("read")
  .route({
    method: "GET",
    path: "/bindings",
    summary: "List surface bindings",
    description:
      "List bindings in the active organization with optional surface and scope filters.",
    tags: ["Bindings"],
  })
  .input(
    z
      .object({
        surface: z.string().min(1).optional().describe("Only return this surface's bindings."),
        scopeId: z.uuid().optional().describe("Only return bindings targeting this scope. A UUID."),
      })
      .describe("Optional binding-list filters."),
  )
  .output(z.array(bindingSchema).describe("The active organization's surface bindings."))
  .handler(async ({ context, input }) =>
    (
      await listBindings(context.db, {
        orgId: context.org.id,
        ...(input.surface ? { surface: input.surface } : {}),
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
      })
    ).map(serializeBinding),
  );

const remove = requireCapability("manage_scopes")
  .route({
    method: "DELETE",
    path: "/bindings/{id}",
    summary: "Delete a surface binding",
    description: "Unbind a surface location in the active organization.",
    tags: ["Bindings"],
  })
  .input(
    z
      .object({
        id: z.uuid().describe("The ID of the binding to delete. A UUID."),
      })
      .describe("The binding to delete."),
  )
  .output(bindingSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeBinding(
        await deleteBinding(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          bindingId: input.id,
        }),
      );
    } catch (error) {
      if (error instanceof BindingNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

export const bindingsRouter = { create, list, delete: remove };
