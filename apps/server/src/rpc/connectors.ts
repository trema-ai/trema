import { ORPCError } from "@orpc/server";
import { fieldDescriptorSchema } from "@trema/connectors";
import { z } from "zod";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { orgScoped, requireCapability } from "#server/rpc/builders.js";
import { authorize } from "#server/services/authorize/index.js";
import {
  archiveConnectorInstallation,
  ClientRegistrationConflictError,
  ClientRegistrationNotFoundError,
  ClientRegistrationValidationError,
  ConnectorApprovalRequiredError,
  ConnectorCatalogDefectError,
  ConnectorConnectionNotFoundError,
  ConnectorInstallationError,
  ConnectorInstallationNotFoundError,
  ConnectorInstallationValidationError,
  ConnectorProviderNotFoundError,
  ConnectorReconnectRequiredError,
  ConnectorSsrfRejectedError,
  ConnectorSyncTransportError,
  ConnectorToolNotAvailableError,
  ConnectorToolValidationError,
  ConnectorTransportError,
  CredentialVerificationError,
  connectorCallbackUrl,
  createClientRegistration,
  createConnectorInstallation,
  createStaticConnection,
  deleteClientRegistration,
  listClientRegistrations,
  listConnectorConnections,
  listConnectorInstallations,
  loadProviderCatalog,
  McpOAuthDiscoveryError,
  NoClientRegistrationError,
  revokeConnectorConnection,
  StaticCredentialValidationError,
  startOAuthConnect,
  syncConnectorInstallation,
  UnsupportedConnectorAuthModeError,
  updateConnectorConnectionLabel,
  updateConnectorInstallation,
} from "#server/services/connectors/index.js";
import { OrgAgentNotFoundError, requireOrgAgent } from "#server/services/org/index.js";

const sourceSchema = z.enum(["platform", "customer", "dynamic"]);
const enabledToolsSchema = z.union([z.literal("all"), z.array(z.string().trim().min(1))]);
const configSchema = z.record(z.string(), z.union([z.string(), z.number(), z.boolean()]));

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

const installationSchema = z.object({
  id: z.uuid(),
  scopeId: z.uuid(),
  kind: z.literal("connector"),
  title: z.string(),
  body: z.json(),
  status: z.enum(["proposed", "active", "archived"]),
  disclosure: z.enum(["standing", "retrieved"]),
  createdById: z.uuid(),
  createdAt: z.string(),
  updatedAt: z.string(),
  version: z.number().int().positive(),
});

function serializeInstallation(
  installation: Awaited<ReturnType<typeof createConnectorInstallation>>,
) {
  return {
    id: installation.id,
    scopeId: installation.scopeId,
    kind: "connector" as const,
    title: installation.title,
    body: installation.body as z.infer<typeof installationSchema>["body"],
    status: installation.status,
    disclosure: installation.disclosure,
    createdById: installation.createdById,
    createdAt: installation.createdAt.toISOString(),
    updatedAt: installation.updatedAt.toISOString(),
    version: installation.version,
  };
}

const connectionSchema = z.object({
  id: z.uuid(),
  providerKey: z.string(),
  ownerPrincipalId: z.uuid(),
  authMode: z.string(),
  label: z.string().nullable(),
  providerScopes: z.array(z.string()),
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
  installations: z.array(z.object({ id: z.uuid(), scopeId: z.uuid() })),
});

const connectionUpdateSchema = z.object({ id: z.uuid(), label: z.string().nullable() });

type ListedConnection = Awaited<ReturnType<typeof listConnectorConnections>>[number];

function serializeConnection(connection: ListedConnection) {
  return {
    ...connection,
    expiresAt: connection.expiresAt?.toISOString() ?? null,
    revokedAt: connection.revokedAt?.toISOString() ?? null,
    lastRefreshSuccess: connection.lastRefreshSuccess?.toISOString() ?? null,
    lastRefreshFailure: connection.lastRefreshFailure?.toISOString() ?? null,
    createdAt: connection.createdAt.toISOString(),
    updatedAt: connection.updatedAt.toISOString(),
  };
}

async function orgAgentPrincipalId(db: Database, orgId: string) {
  return (await requireOrgAgent(db, orgId)).id;
}

function requirePersonalOAuthProvider(providerKey: string) {
  const provider = loadProviderCatalog().find((candidate) => candidate.key === providerKey);
  if (!provider) throw new ConnectorProviderNotFoundError(providerKey);
  if (provider.oauthActor !== "user") {
    throw new UnsupportedConnectorAuthModeError(
      `Provider '${provider.key}' does not support personal OAuth connections`,
    );
  }
  return provider;
}

function throwConnectorError(error: unknown): never {
  if (
    error instanceof ClientRegistrationValidationError ||
    error instanceof ConnectorInstallationError ||
    error instanceof ConnectorInstallationValidationError ||
    error instanceof StaticCredentialValidationError ||
    error instanceof UnsupportedConnectorAuthModeError ||
    error instanceof ConnectorCatalogDefectError ||
    error instanceof ConnectorToolValidationError ||
    error instanceof ConnectorSsrfRejectedError ||
    error instanceof OrgAgentNotFoundError
  ) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof ConnectorApprovalRequiredError) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: error.message,
      data: {
        code: error.code,
        toolKey: error.toolKey,
        installationItemId: error.installationItemId,
      },
    });
  }
  if (
    error instanceof ClientRegistrationNotFoundError ||
    error instanceof ConnectorConnectionNotFoundError ||
    error instanceof ConnectorInstallationNotFoundError ||
    error instanceof ConnectorProviderNotFoundError
  ) {
    throw new ORPCError("NOT_FOUND", { message: error.message });
  }
  if (error instanceof ConnectorToolNotAvailableError) {
    throw new ORPCError("NOT_FOUND", {
      message: error.message,
      data: {
        code: error.code,
        toolKey: error.toolKey,
        ...(error.installationItemId ? { installationItemId: error.installationItemId } : {}),
      },
    });
  }
  if (error instanceof NoClientRegistrationError) {
    throw new ORPCError("PRECONDITION_FAILED", { message: error.message });
  }
  if (error instanceof ConnectorReconnectRequiredError) {
    throw new ORPCError("PRECONDITION_FAILED", {
      message: error.message,
      data: {
        code: error.code,
        reconnectNeeded: error.reconnectNeeded,
        connectionId: error.connectionId,
        providerKey: error.providerKey,
        reason: error.reason,
        ...(error.providerStatus === undefined ? {} : { providerStatus: error.providerStatus }),
        ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      },
    });
  }
  if (error instanceof ClientRegistrationConflictError) {
    throw new ORPCError("CONFLICT", { message: error.message });
  }
  if (error instanceof CredentialVerificationError || error instanceof McpOAuthDiscoveryError) {
    throw new ORPCError("BAD_GATEWAY", { message: error.message });
  }
  if (error instanceof ConnectorSyncTransportError) {
    throw new ORPCError("BAD_REQUEST", { message: error.message });
  }
  if (error instanceof ConnectorTransportError) {
    throw new ORPCError("BAD_GATEWAY", {
      message: error.message,
      data: {
        code: error.code,
        ...(error.status === undefined ? {} : { status: error.status }),
        ...(error.providerCode === undefined ? {} : { providerCode: error.providerCode }),
      },
    });
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
      replace: z.boolean().optional(),
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
          ...(input.replace !== undefined ? { replace: input.replace } : {}),
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
  .output(z.array(registrationSchema.extend({ isUsable: z.boolean() })))
  .handler(async ({ context }) => {
    const registrations = await listClientRegistrations(context.db, context.org.id);
    const secretRows = await context.db.clientRegistration.findMany({
      where: { orgId: context.org.id },
      select: { id: true, clientSecretCiphertext: true },
    });
    const hasSecret = new Map(
      secretRows.map((registration) => [
        registration.id,
        registration.clientSecretCiphertext !== null,
      ]),
    );
    return Promise.all(
      registrations.map(async (registration) => {
        let isUsable =
          registration.source === "dynamic"
            ? registration.clientId !== null
            : registration.source === "customer" &&
              registration.clientId !== null &&
              hasSecret.get(registration.id) === true;
        if (registration.source === "platform" && registration.sharedRef && context.platformApps) {
          isUsable = Boolean(await context.platformApps.get(registration.sharedRef));
        }
        return { ...serializeRegistration(registration), isUsable };
      }),
    );
  });

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

const createInstallation = requireCapability("manage_connectors", {
  scopeId: (input) => (input as { scopeId?: string }).scopeId,
})
  .route({
    method: "POST",
    path: "/connector-installations",
    summary: "Create a connector installation",
    description: "Bind a connector connection into an authorized context scope.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      scopeId: z.uuid(),
      catalogKey: z.string().trim().min(1),
      connectionId: z.uuid(),
      enabledTools: enabledToolsSchema.optional(),
    }),
  )
  .output(installationSchema)
  .handler(async ({ context, input }) => {
    try {
      const scope = await context.db.scope.findFirst({
        where: {
          id: input.scopeId,
          orgId: context.org.id,
          kind: { in: ["org", "shared"] },
        },
        select: { id: true },
      });
      if (!scope) {
        throw new ORPCError("FORBIDDEN", {
          message: "Organization connector installations require an organization or shared scope",
        });
      }
      return serializeInstallation(
        await createConnectorInstallation(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          scopeId: input.scopeId,
          catalogKey: input.catalogKey,
          connectionId: input.connectionId,
          ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
          ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
            ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
            : {}),
          ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
          ...(context.mcpClientFactory ? { clientFactory: context.mcpClientFactory } : {}),
          ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        }),
      );
    } catch (error) {
      throwConnectorError(error);
    }
  });

const updateInstallation = installationScoped
  .route({
    method: "PATCH",
    path: "/connector-installations/{installationItemId}",
    summary: "Update a connector installation",
    description: "Update its connection or tool intent.",
    tags: ["Connectors"],
  })
  .input(
    z
      .object({
        installationItemId: z.uuid(),
        connectionId: z.uuid().optional(),
        enabledTools: enabledToolsSchema.optional(),
      })
      .refine((input) => input.connectionId !== undefined || input.enabledTools !== undefined, {
        message: "At least one editable field is required",
      }),
  )
  .output(installationSchema)
  .handler(async ({ context, input }) => {
    try {
      return serializeInstallation(
        await updateConnectorInstallation(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          installationItemId: input.installationItemId,
          ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
          ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
          ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
            ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
            : {}),
          ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
          ...(context.mcpClientFactory ? { clientFactory: context.mcpClientFactory } : {}),
          ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        }),
      );
    } catch (error) {
      throwConnectorError(error);
    }
  });

const listedInstallationSchema = z.object({
  id: z.uuid(),
  scopeId: z.uuid(),
  catalogKey: z.string(),
  connectionId: z.uuid(),
  enabledTools: enabledToolsSchema,
  syncedTools: z.array(
    z.object({
      name: z.string(),
      description: z.string().optional(),
      annotations: z
        .object({
          readOnlyHint: z.boolean().optional(),
          destructiveHint: z.boolean().optional(),
        })
        .optional(),
    }),
  ),
  status: z.enum(["proposed", "active", "archived"]),
  updatedAt: z.string(),
});

const listInstallations = requireCapability("manage_connectors", {
  scopeId: (input) => (input as { scopeId?: string }).scopeId,
})
  .route({
    method: "GET",
    path: "/connector-installations",
    summary: "List connector installations",
    description: "List manageable organization and shared-scope connection bindings.",
    tags: ["Connectors"],
  })
  .input(z.object({ scopeId: z.uuid().optional(), includeArchived: z.boolean().optional() }))
  .output(z.array(listedInstallationSchema))
  .handler(async ({ context, input }) =>
    (
      await listConnectorInstallations(context.db, {
        orgId: context.org.id,
        ...(input.scopeId ? { scopeId: input.scopeId } : {}),
        ...(input.includeArchived !== undefined ? { includeArchived: input.includeArchived } : {}),
      })
    ).map((installation) => ({
      ...installation,
      updatedAt: installation.updatedAt.toISOString(),
    })),
  );

const archiveInstallation = installationScoped
  .route({
    method: "POST",
    path: "/connector-installations/{installationItemId}/archive",
    summary: "Archive a connector installation",
    description: "Archive one scope binding without revoking its connection.",
    tags: ["Connectors"],
  })
  .input(z.object({ installationItemId: z.uuid() }))
  .output(z.object({ installation: installationSchema }))
  .handler(async ({ context, input }) => {
    try {
      const result = await archiveConnectorInstallation(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        installationItemId: input.installationItemId,
      });
      return { installation: serializeInstallation(result.installation) };
    } catch (error) {
      throwConnectorError(error);
    }
  });

const syncInstallation = installationScoped
  .route({
    method: "POST",
    path: "/connector-installations/{installationItemId}/sync",
    summary: "Sync MCP connector tools",
    description: "Refresh an MCP installation's tool list and apply tool drift rules.",
    tags: ["Connectors"],
  })
  .input(z.object({ installationItemId: z.uuid() }))
  .output(
    z.object({
      installation: installationSchema,
      report: z.object({
        added: z.array(z.string()),
        removed: z.array(z.string()),
        changed: z.array(z.string()),
      }),
    }),
  )
  .handler(async ({ context, input }) => {
    try {
      const result = await syncConnectorInstallation(context.db, {
        orgId: context.org.id,
        actorPrincipalId: context.principal.id,
        installationItemId: input.installationItemId,
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
        ...(context.mcpClientFactory ? { clientFactory: context.mcpClientFactory } : {}),
        ...(context.platformApps ? { platformApps: context.platformApps } : {}),
      });
      return {
        installation: serializeInstallation(result.installation),
        report: result.report,
      };
    } catch (error) {
      throwConnectorError(error);
    }
  });

const catalog = orgScoped
  .route({
    method: "GET",
    path: "/connector-catalog",
    summary: "List connector providers",
    description: "List safe catalog metadata and personal OAuth support.",
    tags: ["Connectors"],
  })
  .output(
    z.array(
      z.object({
        key: z.string(),
        displayName: z.string(),
        description: z.string().optional(),
        logoUrl: z.string().optional(),
        categories: z.array(z.string()),
        docsUrl: z.url(),
        authMode: z.string(),
        transport: z.object({ type: z.enum(["mcp", "rest"]) }),
        supportsPersonalOAuth: z.boolean(),
        defaultScopes: z.array(z.string()),
        availableScopes: z.array(z.string()).optional(),
        configFields: z.record(z.string(), fieldDescriptorSchema),
        credentialFields: z.record(z.string(), fieldDescriptorSchema),
        toolManifest: z.array(z.object({ name: z.string(), description: z.string() })).optional(),
      }),
    ),
  )
  .handler(() =>
    loadProviderCatalog().map((provider) => ({
      key: provider.key,
      displayName: provider.displayName,
      description: provider.description,
      logoUrl: provider.logoUrl,
      categories: provider.categories,
      docsUrl: provider.docsUrl,
      authMode: provider.authMode,
      transport: { type: provider.transport.type },
      supportsPersonalOAuth: provider.oauthActor === "user",
      defaultScopes: provider.auth.defaultScopes,
      ...(provider.auth.availableScopes ? { availableScopes: provider.auth.availableScopes } : {}),
      configFields: provider.configFields,
      credentialFields: provider.credentialFields,
      ...(provider.transport.type === "rest"
        ? {
            toolManifest: provider.toolManifest.map(({ name, description }) => ({
              name,
              description,
            })),
          }
        : {}),
    })),
  );

const meta = requireCapability("manage_connectors")
  .route({
    method: "GET",
    path: "/connectors/meta",
    summary: "Get connector deployment metadata",
    description: "Get the deployment OAuth callback URL.",
    tags: ["Connectors"],
  })
  .output(z.object({ callbackUrl: z.url() }))
  .handler(({ context }) => ({
    callbackUrl: connectorCallbackUrl(context.env.TREMA_AUTH_BASE_URL),
  }));

const startOAuth = requireCapability("manage_connectors", {
  scopeId: (input) => (input as { scopeId?: string }).scopeId,
})
  .route({
    method: "POST",
    path: "/connector-connections/oauth",
    summary: "Start an OAuth connector flow",
    description:
      "Create single-use OAuth state for an organization-agent connection and return the provider authorization URL.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      scopeId: z.uuid(),
      providerKey: z.string().trim().min(1),
      config: configSchema.optional(),
      providerScopes: z.array(z.string().trim().min(1)).optional(),
      label: z.string().trim().min(1).max(60).optional(),
      returnTo: z.url().optional(),
      reconnectConnectionId: z.uuid().optional(),
    }),
  )
  .output(z.object({ authorizationUrl: z.url() }))
  .handler(async ({ context, input }) => {
    log.info("Connector OAuth connect requested", {
      provider: input.providerKey,
      ...(input.providerScopes ? { providerScopes: input.providerScopes } : {}),
    });
    try {
      const ownerPrincipalId = await orgAgentPrincipalId(context.db, context.org.id);
      return await startOAuthConnect(context.db, {
        orgId: context.org.id,
        scopeId: input.scopeId,
        ownerPrincipalId,
        initiatedByPrincipalId: context.principal.id,
        providerKey: input.providerKey,
        authBaseUrl: context.env.TREMA_AUTH_BASE_URL,
        ...(input.config ? { config: input.config } : {}),
        ...(input.providerScopes ? { providerScopes: input.providerScopes } : {}),
        ...(input.label ? { label: input.label } : {}),
        ...(input.returnTo ? { returnTo: input.returnTo } : {}),
        ...(input.reconnectConnectionId
          ? { reconnectConnectionId: input.reconnectConnectionId }
          : {}),
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
      });
    } catch (error) {
      throwConnectorError(error);
    }
  });

const createStatic = requireCapability("manage_connectors", {
  scopeId: (input) => (input as { scopeId?: string }).scopeId,
})
  .route({
    method: "POST",
    path: "/connector-connections/static",
    summary: "Create a static connector connection",
    description:
      "Validate, verify, and encrypt an API-key or basic connection, then install it in the selected organization or shared scope.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      scopeId: z.uuid(),
      providerKey: z.string().trim().min(1),
      config: configSchema,
      credentials: z.record(z.string(), z.string()),
      label: z.string().trim().min(1).max(60).optional(),
      reconnectConnectionId: z.uuid().optional(),
    }),
  )
  .output(
    z.object({
      id: z.uuid(),
      installationId: z.uuid(),
      setupStatus: z.enum(["ready", "syncing", "sync_failed"]),
    }),
  )
  .handler(async ({ context, input }) => {
    try {
      const ownerPrincipalId = await orgAgentPrincipalId(context.db, context.org.id);
      const targetScope = await context.db.scope.findFirst({
        where: {
          id: input.scopeId,
          orgId: context.org.id,
          kind: { in: ["org", "shared"] },
        },
        select: { id: true },
      });
      if (!targetScope) {
        throw new ConnectorInstallationError(
          "Static connector connections require an organization or shared scope",
        );
      }
      const connection = await createStaticConnection(context.db, {
        orgId: context.org.id,
        ownerPrincipalId,
        providerKey: input.providerKey,
        config: input.config,
        credentials: input.credentials,
        ...(input.label ? { label: input.label } : {}),
        ...(input.reconnectConnectionId
          ? { reconnectConnectionId: input.reconnectConnectionId }
          : {}),
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
        installation: {
          actorPrincipalId: context.principal.id,
          scopeId: targetScope.id,
        },
      });
      return {
        id: connection.id,
        installationId: connection.installation.id,
        setupStatus: connection.setupStatus,
      };
    } catch (error) {
      throwConnectorError(error);
    }
  });

const listConnections = requireCapability("manage_connectors")
  .route({
    method: "GET",
    path: "/connector-connections",
    summary: "List connector connections",
    description:
      "List safe connection status metadata and bound installation ids without secret material.",
    tags: ["Connectors"],
  })
  .input(z.object({ providerKey: z.string().trim().min(1).optional() }))
  .output(z.array(connectionSchema))
  .handler(async ({ context, input }) =>
    (
      await listConnectorConnections(
        context.db,
        context.org.id,
        input.providerKey,
        new Date(),
        // Personal connections are managed by their owners in the main view;
        // the admin area lists the agent's connections only.
        await orgAgentPrincipalId(context.db, context.org.id),
      )
    ).map(serializeConnection),
  );

const revokeConnection = requireCapability("manage_connectors")
  .route({
    method: "POST",
    path: "/connector-connections/{connectionId}/revoke",
    summary: "Revoke a connector connection",
    description: "Mark one connector connection revoked locally.",
    tags: ["Connectors"],
  })
  .input(z.object({ connectionId: z.uuid() }))
  .output(z.object({ id: z.uuid(), revokedAt: z.string() }))
  .handler(async ({ context, input }) => {
    try {
      const result = await revokeConnectorConnection(
        context.db,
        context.org.id,
        input.connectionId,
        await orgAgentPrincipalId(context.db, context.org.id),
      );
      return { id: result.id, revokedAt: result.revokedAt.toISOString() };
    } catch (error) {
      throwConnectorError(error);
    }
  });

const updateConnection = requireCapability("manage_connectors")
  .route({
    method: "PATCH",
    path: "/connector-connections/{connectionId}",
    summary: "Update a connector connection",
    description: "Rename one of the organization agent's connections.",
    tags: ["Connectors"],
  })
  .input(z.object({ connectionId: z.uuid(), label: z.string().trim().min(1).max(60).nullable() }))
  .output(connectionUpdateSchema)
  .handler(async ({ context, input }) => {
    try {
      const connection = await updateConnectorConnectionLabel(context.db, {
        orgId: context.org.id,
        connectionId: input.connectionId,
        label: input.label,
        ownerPrincipalId: await orgAgentPrincipalId(context.db, context.org.id),
      });
      return { id: connection.id, label: connection.label };
    } catch (error) {
      throwConnectorError(error);
    }
  });

const memberStartOAuth = orgScoped
  .route({
    method: "POST",
    path: "/member/connector-connections/oauth",
    summary: "Start a member OAuth connector flow",
    description:
      "Create single-use OAuth state for the caller's connection and return the provider authorization URL.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      providerKey: z.string().trim().min(1),
      config: configSchema.optional(),
      providerScopes: z.array(z.string().trim().min(1)).optional(),
      label: z.string().trim().min(1).max(60).optional(),
      returnTo: z.url(),
      reconnectConnectionId: z.uuid().optional(),
    }),
  )
  .output(z.object({ authorizationUrl: z.url() }))
  .handler(async ({ context, input }) => {
    log.info("Connector OAuth connect requested", {
      provider: input.providerKey,
      ...(input.providerScopes ? { providerScopes: input.providerScopes } : {}),
    });
    try {
      requirePersonalOAuthProvider(input.providerKey);
      const personalScope = await context.db.scope.findFirst({
        where: {
          orgId: context.org.id,
          kind: "personal",
          ownerId: context.principal.id,
        },
        select: { id: true },
      });
      if (!personalScope) {
        throw new ORPCError("FORBIDDEN", {
          message: "A personal scope is required to connect this provider",
        });
      }
      return await startOAuthConnect(context.db, {
        orgId: context.org.id,
        scopeId: personalScope.id,
        ownerPrincipalId: context.principal.id,
        initiatedByPrincipalId: context.principal.id,
        providerKey: input.providerKey,
        authBaseUrl: context.env.TREMA_AUTH_BASE_URL,
        ...(input.config ? { config: input.config } : {}),
        ...(input.providerScopes ? { providerScopes: input.providerScopes } : {}),
        ...(input.label ? { label: input.label } : {}),
        returnTo: input.returnTo,
        ...(input.reconnectConnectionId
          ? { reconnectConnectionId: input.reconnectConnectionId }
          : {}),
        ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
      });
    } catch (error) {
      throwConnectorError(error);
    }
  });

const memberListConnections = orgScoped
  .route({
    method: "GET",
    path: "/member/connector-connections",
    summary: "List the caller's connector connections",
    description:
      "List safe status metadata and personal installation ids for the caller's connections.",
    tags: ["Connectors"],
  })
  .input(z.object({ providerKey: z.string().trim().min(1).optional() }))
  .output(z.array(connectionSchema))
  .handler(async ({ context, input }) =>
    (
      await listConnectorConnections(
        context.db,
        context.org.id,
        input.providerKey,
        new Date(),
        context.principal.id,
      )
    ).map(serializeConnection),
  );

const memberRevokeConnection = orgScoped
  .route({
    method: "POST",
    path: "/member/connector-connections/{connectionId}/revoke",
    summary: "Revoke one of the caller's connector connections",
    description: "Mark one caller-owned connector connection revoked locally.",
    tags: ["Connectors"],
  })
  .input(z.object({ connectionId: z.uuid() }))
  .output(z.object({ id: z.uuid(), revokedAt: z.string() }))
  .handler(async ({ context, input }) => {
    try {
      const result = await revokeConnectorConnection(
        context.db,
        context.org.id,
        input.connectionId,
        context.principal.id,
      );
      return { id: result.id, revokedAt: result.revokedAt.toISOString() };
    } catch (error) {
      throwConnectorError(error);
    }
  });

const memberCreateInstallation = orgScoped
  .route({
    method: "POST",
    path: "/member/connector-installations",
    summary: "Create a personal connector installation",
    description:
      "Bind one of the caller's connections into the caller's personal scope with all tools enabled.",
    tags: ["Connectors"],
  })
  .input(
    z.object({
      scopeId: z.uuid(),
      catalogKey: z.string().trim().min(1),
      connectionId: z.uuid(),
    }),
  )
  .output(installationSchema)
  .handler(async ({ context, input }) => {
    try {
      requirePersonalOAuthProvider(input.catalogKey);
      const scope = await context.db.scope.findFirst({
        where: {
          id: input.scopeId,
          orgId: context.org.id,
          kind: "personal",
          ownerId: context.principal.id,
        },
        select: { id: true },
      });
      if (!scope) {
        throw new ORPCError("FORBIDDEN", {
          message: "Members may only install connectors in their own personal scope",
        });
      }
      return serializeInstallation(
        await createConnectorInstallation(context.db, {
          orgId: context.org.id,
          actorPrincipalId: context.principal.id,
          scopeId: scope.id,
          catalogKey: input.catalogKey,
          connectionId: input.connectionId,
          enabledTools: "all",
          ...(context.env.TREMA_CREDENTIAL_MASTER_KEY
            ? { masterKey: context.env.TREMA_CREDENTIAL_MASTER_KEY }
            : {}),
          ...(context.connectorFetch ? { fetch: context.connectorFetch } : {}),
          ...(context.mcpClientFactory ? { clientFactory: context.mcpClientFactory } : {}),
          ...(context.platformApps ? { platformApps: context.platformApps } : {}),
        }),
      );
    } catch (error) {
      if (error instanceof ORPCError) throw error;
      throwConnectorError(error);
    }
  });

export const connectorsRouter = {
  meta,
  catalog: { list: catalog },
  installations: {
    create: createInstallation,
    list: listInstallations,
    update: updateInstallation,
    sync: syncInstallation,
    archive: archiveInstallation,
  },
  registrations: {
    create: createRegistration,
    list: listRegistrations,
    delete: deleteRegistration,
  },
  connect: { startOAuth, createStatic },
  connections: { list: listConnections, revoke: revokeConnection, update: updateConnection },
  member: {
    connect: { startOAuth: memberStartOAuth },
    connections: { list: memberListConnections, revoke: memberRevokeConnection },
    installations: { create: memberCreateInstallation },
  },
};
