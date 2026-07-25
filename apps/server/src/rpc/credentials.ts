import { ORPCError } from "@orpc/server";
import { z } from "zod";

import {
  createServiceCredential,
  listServiceCredentials,
  revokeServiceCredential,
  ServiceCredentialAlreadyRevokedError,
  ServiceCredentialNotFoundError,
} from "#server/services/credentials/index.js";
import { requireCapability, serviceAuthed } from "./builders.js";

const credentialSchema = z
  .object({
    id: z.string().describe("The service credential's unique ID. A UUID (version 7)."),
    name: z.string().describe("The display name used to identify the service credential."),
    principalId: z
      .string()
      .describe("The ID of the principal the service credential acts as. A UUID."),
    createdAt: z
      .string()
      .describe("When the service credential was created. An ISO 8601 date-time."),
    revokedAt: z
      .string()
      .nullable()
      .describe("When the service credential was revoked. Null while it remains active."),
  })
  .describe("Service credential metadata without secret material.");

function serializeCredential(credential: {
  id: string;
  name: string;
  principalId: string;
  createdAt: Date;
  revokedAt: Date | null;
}) {
  return {
    id: credential.id,
    name: credential.name,
    principalId: credential.principalId,
    createdAt: credential.createdAt.toISOString(),
    revokedAt: credential.revokedAt?.toISOString() ?? null,
  };
}

const create = requireCapability("manage_connectors")
  .route({
    method: "POST",
    path: "/service-credentials",
    summary: "Create a service credential",
    description: "Create an agent-bound service credential and return its secret once.",
    tags: ["Service credentials"],
  })
  .input(
    z
      .object({
        name: z
          .string()
          .trim()
          .min(1)
          .describe("A display name for the service credential. Cannot be empty."),
      })
      .describe("The service credential to create."),
  )
  .output(
    credentialSchema
      .extend({
        secret: z
          .string()
          .describe("The service credential secret. Store it now; it is returned only once."),
      })
      .describe("The created service credential and its one-time secret."),
  )
  .handler(async ({ context, input }) => {
    try {
      const { credential, secret } = await createServiceCredential(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        name: input.name,
      });
      return { ...serializeCredential(credential), secret };
    } catch (error) {
      if (error instanceof ServiceCredentialNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      throw error;
    }
  });

const list = requireCapability("manage_connectors")
  .route({
    method: "GET",
    path: "/service-credentials",
    summary: "List service credentials",
    description: "List service credential metadata for the active organization.",
    tags: ["Service credentials"],
  })
  .output(z.array(credentialSchema).describe("The active organization's service credentials."))
  .handler(async ({ context }) =>
    (await listServiceCredentials(context.db, context.org.id)).map(serializeCredential),
  );

const revoke = requireCapability("manage_connectors")
  .route({
    method: "POST",
    path: "/service-credentials/revoke",
    summary: "Revoke a service credential",
    description: "Revoke a service credential in the active organization.",
    tags: ["Service credentials"],
  })
  .input(
    z
      .object({
        credentialId: z.uuid().describe("The ID of the service credential to revoke. A UUID."),
      })
      .describe("The service credential to revoke."),
  )
  .output(credentialSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeCredential(
        await revokeServiceCredential(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          credentialId: input.credentialId,
        }),
      );
    } catch (error) {
      if (error instanceof ServiceCredentialNotFoundError) {
        throw new ORPCError("NOT_FOUND", { message: error.message });
      }
      if (error instanceof ServiceCredentialAlreadyRevokedError) {
        throw new ORPCError("CONFLICT", { message: error.message });
      }
      throw error;
    }
  });

const whoami = serviceAuthed
  .route({
    method: "GET",
    path: "/service-credentials/whoami",
    summary: "Resolve a service credential",
    description: "Return the organization and principal represented by a service credential.",
    tags: ["Service credentials"],
  })
  .output(
    z
      .object({
        orgId: z.string().describe("The ID of the service credential's organization. A UUID."),
        principal: z
          .object({
            id: z.string().describe("The represented principal's unique ID. A UUID (version 7)."),
            kind: z
              .enum(["human", "agent"])
              .describe("The represented principal's kind: `human` or `agent`."),
            displayName: z.string().describe("The represented principal's display name."),
          })
          .describe("The principal represented by the service credential."),
      })
      .describe("The identity represented by the service credential."),
  )
  .handler(({ context }) => ({
    orgId: context.org.id,
    principal: {
      id: context.principal.id,
      kind: context.principal.kind,
      displayName: context.principal.displayName,
    },
  }));

export const serviceCredentialsRouter = { create, list, revoke, whoami };
