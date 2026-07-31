import type { ProviderDef } from "@trema/connectors";
import { loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import { z } from "zod";
import type { Prisma } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import type { ConnectorFetch } from "#server/services/connectors/connect.js";
import type { PlatformAppDirectory } from "#server/services/connectors/registrations.js";
import type { McpClientFactory } from "#server/services/connectors/sync.js";
import type { EmbeddingOptions } from "#server/services/embeddings/index.js";
import { requireOrgAgent } from "#server/services/org/index.js";
import { indexItemSafely } from "#server/services/search/index.js";

/// The provider's own MCP annotations, kept verbatim as classifier signal —
/// they gate nothing (wiki specs/context/06-connectors.md).
export const toolAnnotationsSchema = z
  .object({
    readOnlyHint: z.boolean().optional(),
    destructiveHint: z.boolean().optional(),
  })
  .strict();

export const MAX_SYNCED_CONNECTOR_TOOLS = 256;
export const MAX_CONNECTOR_TOOL_SCHEMA_BYTES = 64 * 1024;
export const MAX_CONNECTOR_TOOL_SCHEMA_DEPTH = 32;

function schemaDepth(value: unknown, seen = new WeakSet<object>()): number {
  if (typeof value !== "object" || value === null) return 0;
  if (seen.has(value)) return MAX_CONNECTOR_TOOL_SCHEMA_DEPTH + 1;
  seen.add(value);
  const children = Array.isArray(value) ? value : Object.values(value);
  return 1 + Math.max(0, ...children.map((child) => schemaDepth(child, seen)));
}

const boundedJsonSchema = z.record(z.string(), z.unknown()).superRefine((schema, context) => {
  if (JSON.stringify(schema).length > MAX_CONNECTOR_TOOL_SCHEMA_BYTES) {
    context.addIssue({
      code: "custom",
      message: `Tool schema exceeds ${MAX_CONNECTOR_TOOL_SCHEMA_BYTES} bytes`,
    });
  }
  if (schemaDepth(schema) > MAX_CONNECTOR_TOOL_SCHEMA_DEPTH) {
    context.addIssue({
      code: "custom",
      message: `Tool schema exceeds depth ${MAX_CONNECTOR_TOOL_SCHEMA_DEPTH}`,
    });
  }
});

export const syncedToolSchema = z
  .object({
    name: z.string().trim().min(1),
    title: z.string().trim().min(1).optional(),
    description: z.string().trim().min(1).optional(),
    inputSchema: boundedJsonSchema.optional(),
    outputSchema: boundedJsonSchema.optional(),
    annotations: toolAnnotationsSchema.optional(),
  })
  .strict();

const installationBodyShape = z
  .object({
    catalogKey: z.string().trim().min(1),
    connectionId: z.uuid(),
    enabledTools: z.union([
      z.literal("all"),
      z.array(z.string().trim().min(1)).refine((names) => new Set(names).size === names.length, {
        message: "enabledTools cannot contain duplicate tool names",
      }),
    ]),
    syncedTools: z
      .array(syncedToolSchema)
      .max(MAX_SYNCED_CONNECTOR_TOOLS)
      .refine((tools) => new Set(tools.map(({ name }) => name)).size === tools.length, {
        message: "syncedTools cannot contain duplicate tool names",
      })
      .optional(),
    syncPending: z.literal(true).optional(),
  })
  .strict();

const defaultCatalog = loadProviderCatalog();

export function createConnectorInstallationBodySchema(catalog: ProviderCatalog = defaultCatalog) {
  return installationBodyShape.superRefine((body, context) => {
    const provider = catalog.find(({ key }) => key === body.catalogKey);
    if (!provider) {
      context.addIssue({
        code: "custom",
        path: ["catalogKey"],
        message: `Unknown connector provider: ${body.catalogKey}`,
      });
      return;
    }

    if (provider.transport.type === "rest" && body.syncedTools !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["syncedTools"],
        message: "REST connector installations cannot contain syncedTools",
      });
    }
    if (provider.transport.type === "rest" && body.syncPending !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["syncPending"],
        message: "REST connector installations cannot be pending MCP sync",
      });
    }
    if (body.syncPending && body.syncedTools !== undefined) {
      context.addIssue({
        code: "custom",
        path: ["syncPending"],
        message: "A pending MCP sync cannot expose synchronized tools",
      });
    }

    if (
      Array.isArray(body.enabledTools) &&
      !(provider.transport.type === "mcp" && body.syncPending === true)
    ) {
      const available = new Set(
        provider.transport.type === "rest"
          ? provider.toolManifest.map(({ name }) => name)
          : (body.syncedTools ?? []).map(({ name }) => name),
      );
      for (const [index, name] of body.enabledTools.entries()) {
        if (!available.has(name)) {
          context.addIssue({
            code: "custom",
            path: ["enabledTools", index],
            message: `Enabled tool '${name}' is not available from provider '${provider.key}'`,
          });
        }
      }
    }
  });
}

export const connectorInstallationBodySchema = createConnectorInstallationBodySchema();

export type ToolAnnotations = z.infer<typeof toolAnnotationsSchema>;
export type SyncedTool = z.infer<typeof syncedToolSchema>;
export type ConnectorInstallationBody = z.infer<typeof installationBodyShape>;

export interface ResolvedInstallationTool extends SyncedTool {}

export function resolveInstallationTools(
  provider: ProviderDef,
  body: ConnectorInstallationBody,
): ResolvedInstallationTool[] {
  const available: SyncedTool[] =
    provider.transport.type === "rest"
      ? provider.toolManifest.map(({ name, description }) => ({ name, description }))
      : (body.syncedTools ?? []);
  const enabled = body.enabledTools === "all" ? undefined : new Set(body.enabledTools);

  return available.filter((tool) => !enabled || enabled.has(tool.name));
}

export class ConnectorInstallationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInstallationValidationError";
  }
}

export class ConnectorInstallationNotFoundError extends Error {
  constructor() {
    super("Connector installation not found");
    this.name = "ConnectorInstallationNotFoundError";
  }
}

function parseBody(body: unknown, catalog: ProviderCatalog): ConnectorInstallationBody {
  const parsed = createConnectorInstallationBodySchema(catalog).safeParse(body);
  if (!parsed.success) {
    throw new ConnectorInstallationValidationError(
      `Invalid connector installation body: ${z.prettifyError(parsed.error)}`,
    );
  }
  return parsed.data;
}

function jsonValue(body: ConnectorInstallationBody): Prisma.InputJsonValue {
  return body as Prisma.InputJsonValue;
}

function repointInstallationBody(
  current: ConnectorInstallationBody,
  connectionId: string,
  provider: ProviderDef,
  catalog: ProviderCatalog,
  connectionCredentialsChanged = false,
): ConnectorInstallationBody {
  const requiresMcpSync =
    provider.transport.type === "mcp" &&
    (current.connectionId !== connectionId || connectionCredentialsChanged);
  return parseBody(
    {
      catalogKey: current.catalogKey,
      connectionId,
      enabledTools: current.enabledTools,
      ...(requiresMcpSync
        ? { syncPending: true as const }
        : {
            ...(current.syncedTools !== undefined ? { syncedTools: current.syncedTools } : {}),
            ...(current.syncPending ? { syncPending: current.syncPending } : {}),
          }),
    },
    catalog,
  );
}

export interface ListConnectorInstallationsInput {
  orgId: string;
  scopeId?: string;
  includeArchived?: boolean;
  catalog?: ProviderCatalog;
  now?: Date;
}

export async function listConnectorInstallations(
  db: Database,
  input: ListConnectorInstallationsInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  const installations = await db.item.findMany({
    where: {
      orgId: input.orgId,
      kind: "connector",
      scope: {
        kind: { in: ["org", "shared"] },
        ...(input.scopeId ? { id: input.scopeId } : {}),
      },
      ...(!input.includeArchived ? { status: { not: "archived" } } : {}),
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });

  return installations.map((installation) => {
    const body = parseBody(installation.body, catalog);
    return {
      id: installation.id,
      scopeId: installation.scopeId,
      catalogKey: body.catalogKey,
      connectionId: body.connectionId,
      enabledTools: body.enabledTools,
      syncedTools: body.syncedTools ?? [],
      status: installation.status,
      updatedAt: installation.updatedAt,
    };
  });
}

export interface ArchiveConnectorInstallationInput {
  orgId: string;
  actorPrincipalId: string;
  installationItemId: string;
  now?: Date;
}

export async function archiveConnectorInstallation(
  db: Database,
  input: ArchiveConnectorInstallationInput,
) {
  const result = await db.$transaction(async (transaction) => {
    await lockConnectorBindingMutations(transaction, input.orgId);
    const existing = await transaction.item.findFirst({
      where: {
        id: input.installationItemId,
        orgId: input.orgId,
        kind: "connector",
      },
    });
    if (!existing) {
      log.warn("Connector installation not found", { itemId: input.installationItemId });
      throw new ConnectorInstallationNotFoundError();
    }
    let installation = existing;

    if (existing.status !== "archived") {
      await transaction.itemVersion.create({
        data: {
          orgId: input.orgId,
          itemId: existing.id,
          version: existing.version,
          title: existing.title,
          body: existing.body as Prisma.InputJsonValue,
        },
      });
      installation = await transaction.item.update({
        where: { orgId_id: { orgId: input.orgId, id: existing.id } },
        data: { status: "archived", version: { increment: 1 } },
      });
      log.info("Connector installation archived", { itemId: installation.id });
    }

    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "connector.installation.archive",
        subject: installation.id,
        payload: { version: installation.version },
      },
    });
    return { installation };
  });
  const { indexConnectorInstallationToolsSafely } = await import(
    "#server/services/connectors/tool-search.js"
  );
  await indexConnectorInstallationToolsSafely(db, {
    orgId: input.orgId,
    installationItemId: input.installationItemId,
  });
  return result;
}

export interface CreateConnectorInstallationInput extends EmbeddingOptions {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  catalogKey: string;
  connectionId: string;
  enabledTools?: "all" | string[];
  clientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  fetch?: ConnectorFetch;
  catalog?: ProviderCatalog;
}

type BindingValidationDb = Pick<
  Prisma.TransactionClient,
  "connectorConnection" | "principal" | "scope"
>;

async function validateBinding(
  db: BindingValidationDb,
  input: {
    orgId: string;
    scopeId: string;
    connectionId: string;
    provider: ProviderDef;
  },
) {
  const [scope, connection, agent] = await Promise.all([
    db.scope.findFirst({
      where: { id: input.scopeId, orgId: input.orgId },
      select: { id: true, kind: true, ownerId: true },
    }),
    db.connectorConnection.findFirst({
      where: { id: input.connectionId, orgId: input.orgId },
      select: { id: true, providerKey: true, ownerPrincipalId: true, revokedAt: true },
    }),
    requireOrgAgent(db, input.orgId),
  ]);
  if (!scope) throw new ConnectorInstallationValidationError("Installation scope not found");
  if (!connection) {
    throw new ConnectorInstallationValidationError("Connector connection not found");
  }
  if (connection.providerKey !== input.provider.key) {
    throw new ConnectorInstallationValidationError(
      "Connector connection provider does not match the installation",
    );
  }
  if (connection.revokedAt) {
    throw new ConnectorInstallationValidationError("Connector connection is revoked");
  }
  if (scope.kind === "personal") {
    if (input.provider.oauthActor !== "user") {
      throw new ConnectorInstallationValidationError(
        "Personal installations require a user-acting OAuth provider",
      );
    }
    if (!scope.ownerId || connection.ownerPrincipalId !== scope.ownerId) {
      throw new ConnectorInstallationValidationError(
        "Personal installations must use the scope owner's connection",
      );
    }
  } else if (connection.ownerPrincipalId !== agent.id) {
    throw new ConnectorInstallationValidationError(
      "Organization and shared installations must use the organization agent's connection",
    );
  }
  return scope;
}

export interface ProvisionConnectorInstallationInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  catalogKey: string;
  connectionId: string;
  enabledTools?: "all" | string[];
  credentialOwnerPrincipalId?: string;
  connectionCredentialsChanged?: boolean;
  catalog?: ProviderCatalog;
}

export async function lockConnectorConnectionBindings(
  transaction: Prisma.TransactionClient,
  orgId: string,
  connectionIds: string | readonly string[],
) {
  const sortedConnectionIds = [
    ...new Set(typeof connectionIds === "string" ? [connectionIds] : connectionIds),
  ].sort();
  for (const connectionId of sortedConnectionIds) {
    const lockKey = `${orgId}:${connectionId}`;
    await transaction.$queryRaw`
      SELECT 1::int AS locked
      FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
    `;
  }
}

export async function lockConnectorBindingMutations(
  transaction: Prisma.TransactionClient,
  orgId: string,
) {
  const lockKey = `${orgId}:connector-bindings`;
  await transaction.$queryRaw`
    SELECT 1::int AS locked
    FROM pg_advisory_xact_lock(hashtextextended(${lockKey}, 0))
  `;
}

async function invalidateMcpConnectionInstallations(
  transaction: Prisma.TransactionClient,
  input: ProvisionConnectorInstallationInput,
  provider: ProviderDef,
  catalog: ProviderCatalog,
) {
  if (provider.transport.type !== "mcp" || !input.connectionCredentialsChanged) return [];

  const candidates = await transaction.item.findMany({
    where: {
      orgId: input.orgId,
      kind: "connector",
      status: { not: "archived" },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const invalidated = [];
  for (const candidate of candidates) {
    let current: ConnectorInstallationBody;
    try {
      current = parseBody(candidate.body, catalog);
    } catch {
      continue;
    }
    if (current.catalogKey !== provider.key || current.connectionId !== input.connectionId)
      continue;

    const body = repointInstallationBody(current, input.connectionId, provider, catalog, true);
    const changed = JSON.stringify(body) !== JSON.stringify(current);
    let installation = candidate;
    if (changed) {
      await transaction.itemVersion.create({
        data: {
          orgId: input.orgId,
          itemId: candidate.id,
          version: candidate.version,
          title: candidate.title,
          body: candidate.body as Prisma.InputJsonValue,
          authorId: candidate.updatedById ?? candidate.createdById,
        },
      });
      installation = await transaction.item.update({
        where: { orgId_id: { orgId: input.orgId, id: candidate.id } },
        data: {
          body: jsonValue(body),
          version: { increment: 1 },
          updatedById: input.actorPrincipalId,
        },
      });
      await transaction.auditLog.create({
        data: {
          orgId: input.orgId,
          actorPrincipalId: input.actorPrincipalId,
          action: "connector.installation.update",
          subject: installation.id,
          payload: {
            changed: true,
            credentialsChanged: true,
            scopeId: installation.scopeId,
            catalogKey: provider.key,
            connectionId: body.connectionId,
            enabledTools: body.enabledTools,
            version: installation.version,
          },
        },
      });
    }
    invalidated.push(installation);
  }
  return invalidated;
}

/**
 * Create the intended installation or repoint the scope's existing provider
 * installation while retaining its tool configuration. The caller owns the
 * surrounding transaction so credential and installation writes can commit
 * together.
 */
export async function provisionConnectorInstallation(
  transaction: Prisma.TransactionClient,
  input: ProvisionConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  const provider = catalog.find(({ key }) => key === input.catalogKey);
  if (!provider) {
    throw new ConnectorInstallationValidationError(
      `Unknown connector provider: ${input.catalogKey}`,
    );
  }

  // The expression index is the final uniqueness guard. Serializing binding
  // mutations also lets us discover and lock both sides of a repoint without
  // another transaction changing the source connection between those steps.
  await lockConnectorBindingMutations(transaction, input.orgId);
  const initialCandidates = await transaction.item.findMany({
    where: {
      orgId: input.orgId,
      scopeId: input.scopeId,
      kind: "connector",
      status: { not: "archived" },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });
  const initialExisting = initialCandidates.find((candidate) => {
    try {
      return parseBody(candidate.body, catalog).catalogKey === provider.key;
    } catch {
      return false;
    }
  });
  const currentConnectionId = initialExisting
    ? parseBody(initialExisting.body, catalog).connectionId
    : undefined;
  await lockConnectorConnectionBindings(transaction, input.orgId, [
    ...(currentConnectionId ? [currentConnectionId] : []),
    input.connectionId,
  ]);

  const [scope, actor] = await Promise.all([
    validateBinding(transaction, {
      orgId: input.orgId,
      scopeId: input.scopeId,
      connectionId: input.connectionId,
      provider,
    }),
    transaction.principal.findFirst({
      where: { id: input.actorPrincipalId, orgId: input.orgId },
      select: { id: true },
    }),
  ]);
  if (!actor) throw new ConnectorInstallationValidationError("Installation actor not found");
  const invalidatedInstallations = await invalidateMcpConnectionInstallations(
    transaction,
    input,
    provider,
    catalog,
  );
  const candidates = await transaction.item.findMany({
    where: {
      orgId: input.orgId,
      scopeId: input.scopeId,
      kind: "connector",
      status: { not: "archived" },
    },
    orderBy: [{ updatedAt: "desc" }, { id: "desc" }],
  });

  const existing = candidates.find((candidate) => {
    try {
      return parseBody(candidate.body, catalog).catalogKey === provider.key;
    } catch {
      return false;
    }
  });
  if (!existing) {
    const body = parseBody(
      {
        catalogKey: provider.key,
        connectionId: input.connectionId,
        enabledTools: input.enabledTools ?? "all",
      },
      catalog,
    );
    const installation = await transaction.item.create({
      data: {
        orgId: input.orgId,
        scopeId: scope.id,
        kind: "connector",
        title: provider.displayName,
        body: jsonValue(body),
        status: "active",
        disclosure: "retrieved",
        createdById: actor.id,
        updatedById: actor.id,
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: actor.id,
        action: "connector.installation.create",
        subject: installation.id,
        payload: {
          scopeId: installation.scopeId,
          catalogKey: provider.key,
          connectionId: body.connectionId,
          enabledTools: body.enabledTools,
          ...(input.credentialOwnerPrincipalId
            ? { credentialOwnerPrincipalId: input.credentialOwnerPrincipalId }
            : {}),
        },
      },
    });
    return { installation, created: true, invalidatedInstallations };
  }

  const current = parseBody(existing.body, catalog);
  const body = repointInstallationBody(
    current,
    input.connectionId,
    provider,
    catalog,
    input.connectionCredentialsChanged,
  );
  const changed = JSON.stringify(body) !== JSON.stringify(current);
  if (changed) {
    await transaction.itemVersion.create({
      data: {
        orgId: input.orgId,
        itemId: existing.id,
        version: existing.version,
        title: existing.title,
        body: existing.body as Prisma.InputJsonValue,
        authorId: existing.updatedById ?? existing.createdById,
      },
    });
  }
  const installation = changed
    ? await transaction.item.update({
        where: { orgId_id: { orgId: input.orgId, id: existing.id } },
        data: {
          body: jsonValue(body),
          version: { increment: 1 },
          updatedById: actor.id,
        },
      })
    : existing;
  await transaction.auditLog.create({
    data: {
      orgId: input.orgId,
      actorPrincipalId: actor.id,
      action: "connector.installation.update",
      subject: installation.id,
      payload: {
        changed,
        provisioned: true,
        scopeId: installation.scopeId,
        catalogKey: provider.key,
        connectionId: body.connectionId,
        enabledTools: body.enabledTools,
        version: installation.version,
        ...(input.credentialOwnerPrincipalId
          ? { credentialOwnerPrincipalId: input.credentialOwnerPrincipalId }
          : {}),
      },
    },
  });
  return { installation, created: false, invalidatedInstallations };
}

export type ConnectorSetupStatus = "ready" | "syncing" | "sync_failed";

export interface FinalizeConnectorInstallationInput extends EmbeddingOptions {
  orgId: string;
  actorPrincipalId: string;
  installation: Awaited<ReturnType<typeof provisionConnectorInstallation>>["installation"];
  masterKey?: string;
  clientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  fetch?: ConnectorFetch;
  catalog?: ProviderCatalog;
}

/**
 * Best-effort replicas and network tool discovery run only after the
 * provisioning transaction commits. A timeout reports that sync continues in
 * the background; a failure leaves the committed installation inert until a
 * later sync succeeds.
 */
export async function finalizeConnectorInstallation(
  db: Database,
  input: FinalizeConnectorInstallationInput,
): Promise<ConnectorSetupStatus> {
  const catalog = input.catalog ?? defaultCatalog;
  const body = parseBody(input.installation.body, catalog);
  const provider = catalog.find(({ key }) => key === body.catalogKey);
  if (!provider) {
    throw new ConnectorInstallationValidationError(
      `Unknown connector provider: ${body.catalogKey}`,
    );
  }

  await indexItemSafely(db, input.installation, input);
  if (provider.transport.type !== "mcp") {
    const { indexConnectorInstallationToolsSafely } = await import(
      "#server/services/connectors/tool-search.js"
    );
    await indexConnectorInstallationToolsSafely(db, {
      orgId: input.orgId,
      installationItemId: input.installation.id,
      ...(input.embedder ? { embedder: input.embedder } : {}),
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      catalog,
    });
    return "ready";
  }

  const { syncConnectorInstallation } = await import("#server/services/connectors/sync.js");
  const pending = syncConnectorInstallation(db, {
    orgId: input.orgId,
    actorPrincipalId: input.actorPrincipalId,
    installationItemId: input.installation.id,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
    ...(input.platformApps ? { platformApps: input.platformApps } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    catalog,
  })
    .then(() => "ready" as const)
    .catch((error) => {
      log.warn("Connector installation sync failed", {
        itemId: input.installation.id,
        provider: provider.key,
        error,
      });
      return "sync_failed" as const;
    });
  let syncTimer: ReturnType<typeof setTimeout> | undefined;
  const status = await Promise.race([
    pending,
    new Promise<"syncing">((resolve) => {
      syncTimer = setTimeout(() => resolve("syncing"), 8000);
    }),
  ]);
  if (syncTimer) clearTimeout(syncTimer);
  return status;
}

export async function createConnectorInstallation(
  db: Database,
  input: CreateConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  const { installation } = await db.$transaction((transaction) =>
    provisionConnectorInstallation(transaction, {
      orgId: input.orgId,
      actorPrincipalId: input.actorPrincipalId,
      scopeId: input.scopeId,
      catalogKey: input.catalogKey,
      connectionId: input.connectionId,
      ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
      catalog,
    }),
  );
  const body = parseBody(installation.body, catalog);
  log.info("Connector installation created", {
    itemId: installation.id,
    scopeId: installation.scopeId,
    provider: body.catalogKey,
    connectionId: body.connectionId,
  });
  await finalizeConnectorInstallation(db, {
    orgId: input.orgId,
    actorPrincipalId: input.actorPrincipalId,
    installation,
    ...(input.embedder ? { embedder: input.embedder } : {}),
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
    ...(input.platformApps ? { platformApps: input.platformApps } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
    catalog,
  });
  return installation;
}

export interface UpdateConnectorInstallationInput extends EmbeddingOptions {
  orgId: string;
  actorPrincipalId: string;
  installationItemId: string;
  connectionId?: string;
  enabledTools?: "all" | string[];
  catalog?: ProviderCatalog;
  clientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  fetch?: ConnectorFetch;
}

export async function updateConnectorInstallation(
  db: Database,
  input: UpdateConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  const updated = await db.$transaction(async (transaction) => {
    await lockConnectorBindingMutations(transaction, input.orgId);
    let existing = await transaction.item.findFirst({
      where: { id: input.installationItemId, orgId: input.orgId, kind: "connector" },
    });
    if (!existing) {
      log.warn("Connector installation not found", { itemId: input.installationItemId });
      throw new ConnectorInstallationNotFoundError();
    }
    const initial = parseBody(existing.body, catalog);
    const provider = catalog.find(({ key }) => key === initial.catalogKey);
    if (!provider) {
      throw new ConnectorInstallationValidationError(
        `Unknown connector provider: ${initial.catalogKey}`,
      );
    }
    let current = parseBody(existing.body, catalog);
    await lockConnectorConnectionBindings(transaction, input.orgId, [
      current.connectionId,
      ...(input.connectionId ? [input.connectionId] : []),
    ]);
    existing = await transaction.item.findFirst({
      where: { id: input.installationItemId, orgId: input.orgId, kind: "connector" },
    });
    if (!existing) throw new ConnectorInstallationNotFoundError();
    current = parseBody(existing.body, catalog);
    const repointed =
      input.connectionId !== undefined
        ? repointInstallationBody(current, input.connectionId, provider, catalog)
        : current;
    const body = parseBody(
      {
        ...repointed,
        ...(input.enabledTools !== undefined ? { enabledTools: input.enabledTools } : {}),
      },
      catalog,
    );
    await validateBinding(transaction, {
      orgId: input.orgId,
      scopeId: existing.scopeId,
      connectionId: body.connectionId,
      provider,
    });
    const changed = JSON.stringify(body) !== JSON.stringify(current);

    if (changed) {
      await transaction.itemVersion.create({
        data: {
          orgId: input.orgId,
          itemId: existing.id,
          version: existing.version,
          title: existing.title,
          body: existing.body as Prisma.InputJsonValue,
          authorId: existing.updatedById ?? existing.createdById,
        },
      });
    }
    const installation = await transaction.item.update({
      where: { orgId_id: { orgId: input.orgId, id: existing.id } },
      data: {
        ...(changed
          ? {
              body: jsonValue(body),
              version: { increment: 1 },
              updatedById: input.actorPrincipalId,
            }
          : {}),
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "connector.installation.update",
        subject: installation.id,
        payload: {
          changed,
          enabledTools: body.enabledTools,
          connectionId: body.connectionId,
          version: installation.version,
        },
      },
    });
    return {
      installation,
      changed,
      connectionChanged: current.connectionId !== body.connectionId,
    };
  });
  if (updated.changed) {
    const body = parseBody(updated.installation.body, catalog);
    log.info("Connector installation updated", {
      itemId: updated.installation.id,
      connectionId: body.connectionId,
    });
  }
  if (updated.connectionChanged) {
    await finalizeConnectorInstallation(db, {
      orgId: input.orgId,
      actorPrincipalId: input.actorPrincipalId,
      installation: updated.installation,
      ...(input.embedder ? { embedder: input.embedder } : {}),
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
      ...(input.platformApps ? { platformApps: input.platformApps } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      catalog,
    });
  } else {
    await indexItemSafely(db, updated.installation, input);
    const { indexConnectorInstallationToolsSafely } = await import(
      "#server/services/connectors/tool-search.js"
    );
    await indexConnectorInstallationToolsSafely(db, {
      orgId: input.orgId,
      installationItemId: updated.installation.id,
      ...(input.embedder ? { embedder: input.embedder } : {}),
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      catalog,
    });
  }
  return updated.installation;
}
