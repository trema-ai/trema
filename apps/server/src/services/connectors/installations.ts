import type { ProviderDef } from "@trema/connectors";
import { loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import { z } from "zod";
import type { Prisma } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import type { ConnectorFetch } from "#/services/connectors/connect.js";
import type { McpClientFactory } from "#/services/connectors/sync.js";

export const sensitivities = ["read", "write", "destructive"] as const;
export const sensitivitySchema = z.enum(sensitivities);

export const syncedToolSchema = z
  .object({
    name: z.string().trim().min(1),
    description: z.string().trim().min(1).optional(),
    sensitivity: sensitivitySchema,
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
    sensitivityOverrides: z.record(z.string().trim().min(1), sensitivitySchema).optional(),
    syncedTools: z
      .array(syncedToolSchema)
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

export type Sensitivity = z.infer<typeof sensitivitySchema>;
export type SyncedTool = z.infer<typeof syncedToolSchema>;
export type ConnectorInstallationBody = z.infer<typeof installationBodyShape>;

export interface ResolvedInstallationTool extends SyncedTool {}

export function resolveInstallationTools(
  provider: ProviderDef,
  body: ConnectorInstallationBody,
): ResolvedInstallationTool[] {
  const available: SyncedTool[] =
    provider.transport.type === "rest"
      ? provider.toolManifest.map(({ name, description, sensitivity }) => ({
          name,
          description,
          sensitivity,
        }))
      : (body.syncedTools ?? []);
  const enabled = body.enabledTools === "all" ? undefined : new Set(body.enabledTools);

  return available.flatMap((tool) => {
    if (enabled && !enabled.has(tool.name)) return [];
    return [
      {
        ...tool,
        sensitivity: body.sensitivityOverrides?.[tool.name] ?? tool.sensitivity ?? "destructive",
      },
    ];
  });
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

export class ConnectorMemberConnectabilityError extends Error {
  readonly code = "member_connection_not_allowed";

  constructor(providerKey: string) {
    super(`Provider '${providerKey}' cannot be installed in a personal scope`);
    this.name = "ConnectorMemberConnectabilityError";
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
      sensitivityOverrides: body.sensitivityOverrides ?? {},
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
  return db.$transaction(async (transaction) => {
    const existing = await transaction.item.findFirst({
      where: {
        id: input.installationItemId,
        orgId: input.orgId,
        kind: "connector",
      },
    });
    if (!existing) throw new ConnectorInstallationNotFoundError();
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
}

export interface CreateConnectorInstallationInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  catalogKey: string;
  connectionId: string;
  enabledTools?: "all" | string[];
  sensitivityOverrides?: Record<string, Sensitivity>;
  masterKey?: string;
  clientFactory?: McpClientFactory;
  fetch?: ConnectorFetch;
  catalog?: ProviderCatalog;
}

type BindingValidationDb = Pick<
  Prisma.TransactionClient,
  "connectorConnection" | "connectorProviderSettings" | "principal" | "scope"
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
      select: { id: true, providerKey: true, principalId: true, revokedAt: true },
    }),
    db.principal.findFirst({
      where: { orgId: input.orgId, kind: "agent", deactivatedAt: null },
      select: { id: true },
    }),
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
    const settings = await db.connectorProviderSettings.findUnique({
      where: {
        orgId_providerKey: { orgId: input.orgId, providerKey: input.provider.key },
      },
      select: { memberEnabled: true },
    });
    if (!input.provider.memberConnectable || settings?.memberEnabled !== true) {
      throw new ConnectorMemberConnectabilityError(input.provider.key);
    }
    if (!scope.ownerId || connection.principalId !== scope.ownerId) {
      throw new ConnectorInstallationValidationError(
        "Personal installations must use the scope owner's connection",
      );
    }
  } else if (!agent || connection.principalId !== agent.id) {
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
      ...(input.sensitivityOverrides ? { sensitivityOverrides: input.sensitivityOverrides } : {}),
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
  if (provider.transport.type === "mcp") {
    const { syncConnectorInstallation } = await import("#/services/connectors/sync.js");
    const sync = syncConnectorInstallation(db, {
      orgId: input.orgId,
      actorPrincipalId: input.actorPrincipalId,
      installationItemId: installation.id,
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      ...(input.clientFactory ? { clientFactory: input.clientFactory } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      catalog,
    }).catch(() => undefined);
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

export interface UpdateConnectorInstallationInput {
  orgId: string;
  actorPrincipalId: string;
  installationItemId: string;
  connectionId?: string;
  enabledTools?: "all" | string[];
  sensitivityOverrides?: Record<string, Sensitivity>;
  catalog?: ProviderCatalog;
}

export async function updateConnectorInstallation(
  db: Database,
  input: UpdateConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  return db.$transaction(async (transaction) => {
    const existing = await transaction.item.findFirst({
      where: { id: input.installationItemId, orgId: input.orgId, kind: "connector" },
    });
    if (!existing) throw new ConnectorInstallationNotFoundError();
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
        ...(input.sensitivityOverrides !== undefined
          ? { sensitivityOverrides: input.sensitivityOverrides }
          : {}),
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
          sensitivityOverrides: body.sensitivityOverrides ?? {},
          version: installation.version,
        },
      },
    });
    return installation;
  });
}
