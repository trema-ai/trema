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

    if (Array.isArray(body.enabledTools)) {
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

export async function createConnectorInstallation(
  db: Database,
  input: CreateConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  const provider = catalog.find(({ key }) => key === input.catalogKey);
  if (!provider) {
    throw new ConnectorInstallationValidationError(
      `Unknown connector provider: ${input.catalogKey}`,
    );
  }
  const body = parseBody(
    {
      catalogKey: input.catalogKey,
      connectionId: input.connectionId,
      enabledTools: input.enabledTools ?? "all",
    },
    catalog,
  );

  const installation = await db.$transaction(async (transaction) => {
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
        },
      },
    });
    return installation;
  });
  log.info("Connector installation created", {
    itemId: installation.id,
    scopeId: installation.scopeId,
    provider: provider.key,
    connectionId: body.connectionId,
  });
  await indexItemSafely(db, installation, input);
  const { indexConnectorInstallationToolsSafely } = await import(
    "#server/services/connectors/tool-search.js"
  );
  await indexConnectorInstallationToolsSafely(db, {
    orgId: input.orgId,
    installationItemId: installation.id,
    ...(input.embedder ? { embedder: input.embedder } : {}),
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    catalog,
  });
  if (provider.transport.type === "mcp") {
    const { syncConnectorInstallation } = await import("#server/services/connectors/sync.js");
    const sync = syncConnectorInstallation(db, {
      orgId: input.orgId,
      actorPrincipalId: input.actorPrincipalId,
      installationItemId: installation.id,
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
      ...(input.platformApps ? { platformApps: input.platformApps } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      catalog,
    }).catch((error) => {
      log.warn("Connector installation sync failed", {
        itemId: installation.id,
        provider: provider.key,
        error,
      });
      return undefined;
    });
    let syncTimer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      sync,
      new Promise<void>((resolve) => {
        syncTimer = setTimeout(resolve, 8000);
      }),
    ]);
    clearTimeout(syncTimer);
  }
  return installation;
}

export interface UpdateConnectorInstallationInput extends EmbeddingOptions {
  orgId: string;
  actorPrincipalId: string;
  installationItemId: string;
  connectionId?: string;
  enabledTools?: "all" | string[];
  catalog?: ProviderCatalog;
}

export async function updateConnectorInstallation(
  db: Database,
  input: UpdateConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  const updated = await db.$transaction(async (transaction) => {
    const existing = await transaction.item.findFirst({
      where: { id: input.installationItemId, orgId: input.orgId, kind: "connector" },
    });
    if (!existing) {
      log.warn("Connector installation not found", { itemId: input.installationItemId });
      throw new ConnectorInstallationNotFoundError();
    }
    const current = parseBody(existing.body, catalog);
    const provider = catalog.find(({ key }) => key === current.catalogKey);
    if (!provider) {
      throw new ConnectorInstallationValidationError(
        `Unknown connector provider: ${current.catalogKey}`,
      );
    }
    const body = parseBody(
      {
        ...current,
        ...(input.connectionId !== undefined ? { connectionId: input.connectionId } : {}),
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
    if (changed) {
      log.info("Connector installation updated", {
        itemId: installation.id,
        connectionId: body.connectionId,
      });
    }
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
    return installation;
  });
  await indexItemSafely(db, updated, input);
  const { indexConnectorInstallationToolsSafely } = await import(
    "#server/services/connectors/tool-search.js"
  );
  await indexConnectorInstallationToolsSafely(db, {
    orgId: input.orgId,
    installationItemId: updated.id,
    ...(input.embedder ? { embedder: input.embedder } : {}),
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    catalog,
  });
  return updated;
}
