import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { interpolate, loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import type { Prisma } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type ConnectorInstallationBody,
  ConnectorInstallationNotFoundError,
  createConnectorInstallationBodySchema,
  type Sensitivity,
  type SyncedTool,
} from "#server/services/connectors/installations.js";
import {
  ConnectorReconnectRequiredError,
  resolveConnectionCredential,
} from "#server/services/connectors/refresh.js";
import type { PlatformAppDirectory } from "#server/services/connectors/registrations.js";

const defaultCatalog = loadProviderCatalog();

export interface McpListedTool {
  name: string;
  description?: string | undefined;
  annotations?:
    | {
        readOnlyHint?: boolean | undefined;
        destructiveHint?: boolean | undefined;
      }
    | undefined;
}

export function sensitivityFromMcpAnnotations(
  annotations: McpListedTool["annotations"],
): Sensitivity {
  if (annotations?.readOnlyHint === true) return "read";
  if (annotations?.destructiveHint === false) return "write";
  return "destructive";
}

const sensitivityRank: Record<Sensitivity, number> = { read: 0, write: 1, destructive: 2 };

function maxSensitivity(a: Sensitivity, b: Sensitivity): Sensitivity {
  return sensitivityRank[a] >= sensitivityRank[b] ? a : b;
}

export function mapMcpTool(tool: McpListedTool): SyncedTool {
  const declared = sensitivityFromMcpAnnotations(tool.annotations);
  return {
    name: tool.name,
    ...(tool.description ? { description: tool.description } : {}),
    // Annotations are the server's own claim; `read` executes ungated, so it
    // is only ever granted by an admin override — synced classes floor at write.
    sensitivity: maxSensitivity(declared, "write"),
    declaredSensitivity: declared,
  };
}

export interface SyncReport {
  added: string[];
  removed: string[];
  changed: string[];
}

export function mergeSyncedTools(
  body: ConnectorInstallationBody,
  freshTools: readonly SyncedTool[],
): { body: ConnectorInstallationBody; report: SyncReport } {
  const previous = new Map((body.syncedTools ?? []).map((tool) => [tool.name, tool]));
  // A re-sync may raise a tool's sensitivity, never lower it; lowering goes
  // through an admin's sensitivityOverrides.
  const fresh = new Map(
    freshTools.map((tool) => {
      const before = previous.get(tool.name);
      return [
        tool.name,
        before
          ? { ...tool, sensitivity: maxSensitivity(tool.sensitivity, before.sensitivity) }
          : tool,
      ] as const;
    }),
  );
  const added = [...fresh.keys()].filter((name) => !previous.has(name));
  const removed = [...previous.keys()].filter((name) => !fresh.has(name));
  const changed = [...fresh.entries()].flatMap(([name, tool]) => {
    const before = previous.get(name);
    return before && JSON.stringify(before) !== JSON.stringify(tool) ? [name] : [];
  });
  const enabledTools =
    body.enabledTools === "all" ? "all" : body.enabledTools.filter((name) => fresh.has(name));

  return {
    body: { ...body, enabledTools, syncedTools: [...fresh.values()] },
    report: { added, removed, changed },
  };
}

export class ConnectorSyncTransportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorSyncTransportError";
  }
}

export interface McpToolsClient {
  listTools(params?: { cursor?: string }): Promise<{
    tools: McpListedTool[];
    nextCursor?: string | undefined;
  }>;
  callTool?(params: {
    name: string;
    arguments?: Record<string, unknown>;
  }): Promise<McpToolCallResult>;
  close(): Promise<void>;
}

export type McpToolCallResult = Awaited<ReturnType<Client["callTool"]>>;

export interface McpClientFactoryInput {
  serverUrl: string;
  authorization?: string;
  fetch?: typeof globalThis.fetch;
}

export type McpClientFactory = (input: McpClientFactoryInput) => Promise<McpToolsClient>;

export const createStreamableHttpMcpClient: McpClientFactory = async (input) => {
  const client = new Client({ name: "trema-connector-sync", version: "1.0.0" });
  const transport = new StreamableHTTPClientTransport(new URL(input.serverUrl), {
    ...(input.authorization
      ? { requestInit: { headers: { Authorization: input.authorization } } }
      : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  await client.connect(transport as Parameters<Client["connect"]>[0]);
  return {
    listTools: async (params) => {
      const result = await client.listTools(params);
      return {
        tools: result.tools.map(({ name, description, annotations }) => ({
          name,
          ...(description ? { description } : {}),
          ...(annotations
            ? {
                annotations: {
                  ...(annotations.readOnlyHint !== undefined
                    ? { readOnlyHint: annotations.readOnlyHint }
                    : {}),
                  ...(annotations.destructiveHint !== undefined
                    ? { destructiveHint: annotations.destructiveHint }
                    : {}),
                },
              }
            : {}),
        })),
        ...(result.nextCursor ? { nextCursor: result.nextCursor } : {}),
      };
    },
    callTool: (params) => client.callTool(params),
    close: () => client.close(),
  };
};

function parsedBody(value: unknown, catalog: ProviderCatalog): ConnectorInstallationBody {
  const parsed = createConnectorInstallationBodySchema(catalog).safeParse(value);
  if (!parsed.success) {
    throw new ConnectorSyncTransportError("Connector installation body is invalid");
  }
  return parsed.data;
}

interface CredentialPayload {
  accessToken?: unknown;
  access_token?: unknown;
  token?: unknown;
  raw?: unknown;
}

function bearerToken(payload: CredentialPayload): string | undefined {
  const raw =
    typeof payload.raw === "object" && payload.raw !== null && !Array.isArray(payload.raw)
      ? (payload.raw as Record<string, unknown>)
      : undefined;
  for (const value of [
    payload.accessToken,
    payload.access_token,
    payload.token,
    raw?.access_token,
  ]) {
    if (typeof value === "string" && value.length > 0) return value;
  }
  return undefined;
}

async function resolveBearerToken(
  db: Database,
  orgId: string,
  connectionId: string,
  masterKey: string | undefined,
  now: Date,
  catalog: ProviderCatalog,
  platformApps: PlatformAppDirectory | undefined,
  fetch: typeof globalThis.fetch | undefined,
): Promise<{
  token: string | undefined;
  config: Record<string, string | number | boolean>;
}> {
  const resolved = await resolveConnectionCredential(db, {
    orgId,
    connectionId,
    ...(masterKey ? { masterKey } : {}),
    catalog,
    ...(platformApps ? { platformApps } : {}),
    ...(fetch ? { fetch } : {}),
    now,
  });
  return {
    token: bearerToken(resolved.credential),
    config: resolved.config,
  };
}

export interface SyncConnectorInstallationInput {
  orgId: string;
  actorPrincipalId: string;
  installationItemId: string;
  masterKey?: string;
  catalog?: ProviderCatalog;
  clientFactory?: McpClientFactory;
  platformApps?: PlatformAppDirectory;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}

export async function syncConnectorInstallation(
  db: Database,
  input: SyncConnectorInstallationInput,
) {
  const catalog = input.catalog ?? defaultCatalog;
  log.debug("Connector sync started", { itemId: input.installationItemId });
  try {
    const installation = await db.item.findFirst({
      where: { id: input.installationItemId, orgId: input.orgId, kind: "connector" },
    });
    if (!installation) throw new ConnectorInstallationNotFoundError();
    const body = parsedBody(installation.body, catalog);
    const provider = catalog.find(({ key }) => key === body.catalogKey);
    if (!provider) {
      throw new ConnectorSyncTransportError("Connector provider is not in the catalog");
    }
    if (provider.transport.type !== "mcp") {
      throw new ConnectorSyncTransportError(
        `Provider '${provider.key}' uses REST; only MCP providers support tool sync`,
      );
    }

    const resolved = await resolveBearerToken(
      db,
      input.orgId,
      body.connectionId,
      input.masterKey,
      input.now ?? new Date(),
      catalog,
      input.platformApps,
      input.fetch,
    );
    const serverUrl = interpolate(provider.transport.serverUrl, { config: resolved.config });
    const client = await (input.clientFactory ?? createStreamableHttpMcpClient)({
      serverUrl,
      ...(resolved.token ? { authorization: `Bearer ${resolved.token}` } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
    const listed: McpListedTool[] = [];
    try {
      let cursor: string | undefined;
      do {
        const page = await client.listTools(cursor ? { cursor } : undefined);
        listed.push(...page.tools);
        cursor = page.nextCursor;
      } while (cursor);
    } finally {
      await client.close();
    }
    const freshTools = listed.map(mapMcpTool);

    const result = await db.$transaction(async (transaction) => {
      const current = await transaction.item.findFirst({
        where: { id: installation.id, orgId: input.orgId, kind: "connector" },
      });
      if (!current) throw new ConnectorInstallationNotFoundError();
      const currentBody = parsedBody(current.body, catalog);
      if (currentBody.catalogKey !== provider.key) {
        throw new ConnectorSyncTransportError("Connector provider changed during tool sync");
      }
      const merged = mergeSyncedTools(currentBody, freshTools);
      const validated = parsedBody(merged.body, catalog);
      const changed = JSON.stringify(validated) !== JSON.stringify(currentBody);
      if (changed) {
        await transaction.itemVersion.create({
          data: {
            orgId: input.orgId,
            itemId: current.id,
            version: current.version,
            title: current.title,
            body: current.body as Prisma.InputJsonValue,
            authorId: current.updatedById ?? current.createdById,
          },
        });
      }
      const item = changed
        ? await transaction.item.update({
            where: { orgId_id: { orgId: input.orgId, id: current.id } },
            data: {
              body: validated as Prisma.InputJsonValue,
              version: { increment: 1 },
              updatedById: input.actorPrincipalId,
            },
          })
        : current;
      await transaction.auditLog.create({
        data: {
          orgId: input.orgId,
          actorPrincipalId: input.actorPrincipalId,
          action: "connector.installation.sync",
          subject: item.id,
          payload: {
            catalogKey: provider.key,
            ...merged.report,
          },
        },
      });
      return { installation: item, report: merged.report };
    });

    log.info("Connector sync completed", {
      itemId: installation.id,
      connector: provider.key,
      addedCount: result.report.added.length,
      removedCount: result.report.removed.length,
      changedCount: result.report.changed.length,
    });
    return result;
  } catch (error) {
    if (
      error instanceof ConnectorInstallationNotFoundError ||
      error instanceof ConnectorSyncTransportError ||
      error instanceof ConnectorReconnectRequiredError
    ) {
      log.warn("Connector sync failed", {
        itemId: input.installationItemId,
        reason: error.name,
      });
    } else {
      log.error("Connector sync failed", {
        itemId: input.installationItemId,
        error,
      });
    }
    throw error;
  }
}
