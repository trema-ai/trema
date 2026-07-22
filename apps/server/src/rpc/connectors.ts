import { ORPCError } from "@orpc/server";
import { z } from "zod";

import { orgScoped, requireCapability } from "#/rpc/builders.js";
import { authorize } from "#/services/authorize/index.js";
import {
  ClientRegistrationConflictError,
  ClientRegistrationNotFoundError,
  ClientRegistrationValidationError,
  ConnectorCatalogDefectError,
  ConnectorCredentialNotFoundError,
  ConnectorInstallationError,
  ConnectorProviderNotFoundError,
  CredentialVerificationError,
  createClientRegistration,
  createStaticCredential,
  deleteClientRegistration,
  listClientRegistrations,
  listConnectorCredentials,
  NoClientRegistrationError,
  revokeConnectorCredential,
  StaticCredentialValidationError,
  startOAuthConnect,
  UnsupportedConnectorAuthModeError,
} from "#/services/connectors/index.js";

const sourceSchema = z.enum(["platform", "customer", "dynamic"]);
const registrationSchema = z.object({
  id: z.uuid(),
  providerKey: z.string(),
  source: sourceSchema,
  clientId: z.string().nullable(),
  sharedRef: z.string().nullable(),
  adminConsentGranted: z.boolean().nullable(),
  notes: z.string().nullable(),
  createdAt: z.string(),
  updatedAt: z.string(),
});

function serializeRegistration(registration: Awaited<ReturnType<typeof createClientRegistration>>) {
  return {
    id: registration.id,
    providerKey: registration.providerKey,
    source: registration.source,
    clientId: registration.clientId,
    sharedRef: registration.sharedRef,
    adminConsentGranted: registration.adminConsentGranted,
    notes: registration.notes,
    createdAt: registration.createdAt.toISOString(),
    updatedAt: registration.updatedAt.toISOString(),
  };
}

const credentialSchema = z.object({
  id: z.uuid(),
  installationItemId: z.uuid(),
  principalId: z.uuid(),
  mode: z.string(),
  expiresAt: z.string().nullable(),
  revokedAt: z.string().nullable(),
  lastRefreshSuccess: z.string().nullable(),
  lastRefreshFailure: z.string().nullable(),
  refreshAttempts: z.number().int().nonnegative(),
  refreshExhausted: z.boolean(),
  createdAt: z.string(),
  updatedAt: z.string(),
  isRevoked: z.boolean(),
  isExpired: z.boolean(),
  isValid: z.boolean(),
});

type ListedCredential = Awaited<ReturnType<typeof listConnectorCredentials>>[number];

function serializeCredential(credential: ListedCredential) {
  return {
    ...credential,
    expiresAt: credential.expiresAt?.toISOString() ?? null,
    revokedAt: credential.revokedAt?.toISOString() ?? null,
    lastRefreshSuccess: credential.lastRefreshSuccess?.toISOString() ?? null,
    lastRefreshFailure: credential.lastRefreshFailure?.toISOString() ?? null,
    createdAt: credential.createdAt.toISOString(),
    updatedAt: credential.updatedAt.toISOString(),
  };
}

function throwConnectorError(error: unknown): never {
  if (
    error instanceof ClientRegistrationValidationError ||
    error instanceof ConnectorInstallationError ||
    error instanceof StaticCredentialValidationError ||
    error instanceof UnsupportedConnectorAuthModeError ||
    error instanceof ConnectorCatalogDefectError
  ) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (
    error instanceof ClientRegistrationNotFoundError ||
    error instanceof ConnectorCredentialNotFoundError ||
    error instanceof ConnectorProviderNotFoundError
  ) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof NoClientRegistrationError) {
    throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
  }
  if (error instanceof ClientRegistrationConflictError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof CredentialVerificationError) {
    throw new ORPCError("BAD_GATEWAY", { message: error.message });
  }
  throw error;
}

const createRegistration = requireCapability("manage_connectors")
  .route({
    method: "POST",
    path: "/connector-registrations",
    summary: "Create a connector client registration",
    description: "Create organization-level OAuth client registration metadata.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      providerKey: z.string().trim().min(1),
      source: sourceSchema,
      clientId: z.string().trim().min(1).optional(),
      clientSecret: z.string().min(1).optional(),
      sharedRef: z.string().trim().min(1).optional(),
      adminConsentGranted: z.boolean().optional(),
      notes: z.string().optional(),
    }),
  )
  .output(registrationSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeRegistration(
        await createClientRegistration(context.db, {
          orgId: context.org.id,
          providerKey: input.providerKey,
          source: input.source,
          ...(input.clientId ? { clientId: input.clientId } : {}),
          ...(input.clientSecret ? { clientSecret: input.clientSecret } : {}),
          ...(input.sharedRef ? { sharedRef: input.sharedRef } : {}),
          ...(input.adminConsentGranted !== undefined
            ? { adminConsentGranted: input.adminConsentGranted }
            : {}),
          ...(input.notes !== undefined ? { notes: input.notes } : {}),
          ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
            ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
            : {}),
        }),
      );
    } catch (error) {
      throwConnectorError(error);
    }
  });

const listRegistrations = requireCapability("manage_connectors")
  .route({
    method: "GET",
    path: "/connector-registrations",
    summary: "List connector client registrations",
    description: "List registration metadata without client secret material.",
    tags: ["Connectors"],
  })
  .output(z.array(registrationSchema))
  .handler(async ({ context }) =>
    (await listClientRegistrations(context.db, context.org.id)).map(serializeRegistration),
  );

const deleteRegistration = requireCapability("manage_connectors")
  .route({
    method: "DELETE",
    path: "/connector-registrations/{id}",
    summary: "Delete a connector client registration",
    description: "Delete one organization-level connector client registration.",
    tags: ["Connectors"],
  })
  .input(z.object({ id: z.uuid() }))
  .output(z.object({ id: z.uuid() }))
  .handler(async ({ context, input }) => {
    try {
      return await deleteClientRegistration(context.db, context.org.id, input.id);
    } catch (error) {
      throwConnectorError(error);
    }
  });

const installationScoped = orgScoped.use(async ({ context, next }, input) => {
  const installationItemId = (input as { installationItemId?: unknown }).installationItemId;
  if (typeof installationItemId !== "string") {
    throw new ORPCError("BAD_REQUEST", { message: "Installation item ID is required" });
  }
  const item = await context.db.item.findFirst({
    where: { id: installationItemId, orgId: context.org.id },
    select: { kind: true, scopeId: true },
  });
  if (item?.kind !== "connector") {
    throw new ORPCError("NOT_FOUND", { message: "Connector installation not found" });
  }
  if (!(await authorize(context.principal, "manage_connectors", item.scopeId, context.db))) {
    throw new ORPCError("FORBIDDEN", { message: "Capability required: manage_connectors" });
  }
  return next({ context: { authorizedScopeId: item.scopeId } });
});

const startOAuth = installationScoped
  .route({
    method: "POST",
    path: "/connector-installations/{installationItemId}/connect/oauth",
    summary: "Start an OAuth connector flow",
    description: "Create single-use OAuth state and return the provider authorization URL.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      installationItemId: z.uuid(),
      providerKey: z.string().trim().min(1),
      principalId: z.uuid(),
      returnTo: z.url().optional(),
      config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  )
  .output(z.object({ authorizationUrl: z.url() }))
  .handler(async ({ context, input }) => {
    try {
      return await startOAuthConnect(context.db, {
        orgId: context.org.id,
        providerKey: input.providerKey,
        installationItemId: input.installationItemId,
        principalId: input.principalId,
        authBaseUrl: context.env.TREMA_AUTH_BASE_URL,
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(input.returnTo ? { returnTo: input.returnTo } : {}),
        ...(input.config ? { config: input.config } : {}),
        ...(context.platformApps ? { platformApps: context.platformApps } : {}),
      });
    } catch (error) {
      throwConnectorError(error);
    }
  });

const createStatic = installationScoped
  .route({
    method: "POST",
    path: "/connector-installations/{installationItemId}/credentials",
    summary: "Create a static connector credential",
    description: "Validate, verify, and encrypt an API-key or basic credential.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      installationItemId: z.uuid(),
      providerKey: z.string().trim().min(1),
      principalId: z.uuid(),
      credentials: z.record(z.string(), z.string()),
      config: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
  )
  .output(credentialSchema)
  .handler(async ({ context, input }) => {
    try {
      const credential = await createStaticCredential(context.db, {
        orgId: context.org.id,
        providerKey: input.providerKey,
        installationItemId: input.installationItemId,
        principalId: input.principalId,
        credentials: input.credentials,
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(input.config ? { config: input.config } : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
      });
      return serializeCredential({
        ...credential,
        isRevoked: false,
        isExpired: false,
        isValid: true,
      });
    } catch (error) {
      throwConnectorError(error);
    }
  });

const listCredentials = installationScoped
  .route({
    method: "GET",
    path: "/connector-installations/{installationItemId}/credentials",
    summary: "List connector credentials",
    description: "List credential metadata, refresh bookkeeping, and validity flags only.",
    tags: ["Connectors"],
  })
  .input(z.object({ installationItemId: z.uuid() }))
  .output(z.array(credentialSchema))
  .handler(async ({ context, input }) =>
    (await listConnectorCredentials(context.db, context.org.id, input.installationItemId)).map(
      serializeCredential,
    ),
  );

const revokeCredential = installationScoped
  .route({
    method: "POST",
    path: "/connector-installations/{installationItemId}/credentials/{credentialId}/revoke",
    summary: "Revoke a connector credential",
    description: "Mark a connector credential revoked locally.",
    tags: ["Connectors"],
  })
  .input(z.object({ installationItemId: z.uuid(), credentialId: z.uuid() }))
  .output(z.object({ id: z.uuid(), revokedAt: z.string() }))
  .handler(async ({ context, input }) => {
    try {
      const result = await revokeConnectorCredential(
        context.db,
        context.org.id,
        input.installationItemId,
        input.credentialId,
      );
      return { id: result.id, revokedAt: result.revokedAt.toISOString() };
    } catch (error) {
      throwConnectorError(error);
    }
  });

export const connectorsRouter = {
  registrations: {
    create: createRegistration,
    list: listRegistrations,
    delete: deleteRegistration,
  },
  connect: { startOAuth, createStatic },
  credentials: { list: listCredentials, revoke: revokeCredential },
};
