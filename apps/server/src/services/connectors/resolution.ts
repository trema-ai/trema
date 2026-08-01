import { loadProviderCatalog, type ProviderCatalog, type ProviderDef } from "@trema/connectors";

import type { PrincipalKind, Role, ScopeKind } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { effectiveRolesAtScope } from "#server/services/authorize/index.js";
import {
  ConnectorConnectionNotFoundError,
  connectorConnectionMetadataLabel,
} from "#server/services/connectors/connect.js";
import {
  type ConnectorInstallationBody,
  createConnectorInstallationBodySchema,
  type ResolvedInstallationTool,
  resolveInstallationTools,
} from "#server/services/connectors/installations.js";
import { ConnectorReconnectRequiredError } from "#server/services/connectors/refresh.js";
import { ConnectorProviderNotFoundError } from "#server/services/connectors/registrations.js";

const defaultCatalog = loadProviderCatalog();

export interface ConnectorResolutionAuditBinding {
  installationItemId: string;
  connectionId: string;
  credentialOwnerPrincipalId: string;
  connectorKey: string;
}

export class ConnectorToolNotAvailableError extends Error {
  readonly code = "connector_tool_not_available";

  constructor(
    readonly toolKey: string,
    readonly installationItemId?: string,
    readonly auditBinding?: ConnectorResolutionAuditBinding,
  ) {
    super(`Connector tool '${toolKey}' is not available`);
    this.name = "ConnectorToolNotAvailableError";
  }
}

export class ConnectorToolValidationError extends Error {
  readonly code = "connector_tool_validation_failed";

  constructor(message: string) {
    super(message);
    this.name = "ConnectorToolValidationError";
  }
}

export type ConnectorAccessDenialReason =
  | "credential_ineligible"
  | "requester_unlinked"
  | "minimum_role_required";

export class ConnectorAccessDeniedError extends Error {
  readonly code = "connector_access_denied";

  constructor(
    readonly installationItemId: string,
    readonly reason: ConnectorAccessDenialReason,
    readonly auditBinding: ConnectorResolutionAuditBinding,
  ) {
    super("This connector is not available to the requester in this session");
    this.name = "ConnectorAccessDeniedError";
  }
}

export interface ConnectorResolutionContext {
  orgId: string;
  /** Scope IDs in inheritance order, widest first. */
  scopeChain: readonly string[];
  scopeKind: ScopeKind;
  requesterPrincipalId: string | null;
}

export interface ResolvedConnectorInstallation {
  installationItemId: string;
  installationScopeId: string;
  connectorKey: string;
  connectionId: string;
  credentialOwnerPrincipalId: string;
  connectionLabel: string;
  connectionSource: "personal" | "organization";
  body: ConnectorInstallationBody;
  provider: ProviderDef;
  tools: ResolvedInstallationTool[];
}

export interface ResolvedConnectorTool extends ResolvedConnectorInstallation {
  toolKey: string;
  toolName: string;
  tool: ResolvedInstallationTool;
  description?: string;
  annotations?: ResolvedInstallationTool["annotations"];
}

function omittedFromDiscovery(error: unknown): boolean {
  return (
    error instanceof ConnectorAccessDeniedError ||
    error instanceof ConnectorConnectionNotFoundError ||
    error instanceof ConnectorProviderNotFoundError ||
    error instanceof ConnectorReconnectRequiredError ||
    error instanceof ConnectorToolValidationError
  );
}

interface SelectedInstallation {
  id: string;
  scopeId: string;
  scope: { kind: ScopeKind; ownerId: string | null };
  body: unknown;
}

function rawCatalogKey(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const key = (value as Record<string, unknown>).catalogKey;
  return typeof key === "string" ? key : undefined;
}

function parseToolKey(toolKey: string): { catalogKey: string; toolName: string } {
  const separator = toolKey.indexOf(":");
  if (separator <= 0 || separator === toolKey.length - 1) {
    throw new ConnectorToolValidationError(
      "Connector toolKey must use the 'catalogKey:toolName' format",
    );
  }
  return {
    catalogKey: toolKey.slice(0, separator),
    toolName: toolKey.slice(separator + 1),
  };
}

async function selectedInstallations(
  db: Database,
  context: ConnectorResolutionContext,
): Promise<Map<string, SelectedInstallation>> {
  if (context.scopeChain.length === 0) {
    throw new ConnectorToolValidationError("At least one connector scope is required");
  }
  const installations = await db.item.findMany({
    where: {
      orgId: context.orgId,
      scopeId: { in: [...new Set(context.scopeChain)] },
      kind: "connector",
      status: "active",
    },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
    select: {
      id: true,
      scopeId: true,
      body: true,
      scope: { select: { kind: true, ownerId: true } },
    },
  });

  const selected = new Map<string, SelectedInstallation>();
  for (const scopeId of [...context.scopeChain].reverse()) {
    for (const installation of installations) {
      if (installation.scopeId !== scopeId) continue;
      const providerKey = rawCatalogKey(installation.body);
      if (providerKey !== undefined && !selected.has(providerKey)) {
        selected.set(providerKey, installation);
      }
    }
  }
  return selected;
}

function roleRank(role: Role): number {
  return { viewer: 0, member: 1, admin: 2, owner: 3 }[role];
}

function credentialEligible(input: {
  sessionScopeKind: ScopeKind;
  requesterPrincipalId: string | null;
  installationScope: { kind: ScopeKind; ownerId: string | null };
  owner: { id: string; kind: PrincipalKind; deactivatedAt: Date | null };
  provider: ProviderDef;
}): boolean {
  if (input.owner.deactivatedAt !== null) return false;
  if (input.owner.kind === "human") {
    return (
      input.provider.oauthActor === "user" &&
      input.installationScope.kind === "personal" &&
      input.installationScope.ownerId === input.owner.id &&
      input.sessionScopeKind === "personal" &&
      input.requesterPrincipalId === input.owner.id
    );
  }

  if (input.installationScope.kind === "personal") return false;
  // User-acting OAuth owned by the organization agent may serve only
  // organization and shared sessions. App OAuth, static credentials, and M2M
  // credentials retain ordinary inherited installation reach.
  return input.provider.oauthActor !== "user" || input.sessionScopeKind !== "personal";
}

async function assertInstallationAccess(
  db: Database,
  context: ConnectorResolutionContext,
  installation: SelectedInstallation,
  body: ConnectorInstallationBody,
  auditBinding: ConnectorResolutionAuditBinding,
): Promise<void> {
  if (body.access.kind === "scope") return;
  if (context.requesterPrincipalId === null) {
    throw new ConnectorAccessDeniedError(installation.id, "requester_unlinked", auditBinding);
  }
  const requester = await db.principal.findFirst({
    where: {
      id: context.requesterPrincipalId,
      orgId: context.orgId,
      kind: "human",
      deactivatedAt: null,
    },
    select: { id: true, orgId: true, kind: true },
  });
  if (requester === null) {
    throw new ConnectorAccessDeniedError(installation.id, "requester_unlinked", auditBinding);
  }
  const minimumRole = body.access.role;
  const roles = await effectiveRolesAtScope(requester, installation.scopeId, db);
  if (!roles.some((role) => roleRank(role) >= roleRank(minimumRole))) {
    throw new ConnectorAccessDeniedError(installation.id, "minimum_role_required", auditBinding);
  }
}

async function resolveSelectedInstallation(
  db: Database,
  context: ConnectorResolutionContext,
  providerKey: string,
  installation: SelectedInstallation,
  catalog: ProviderCatalog,
): Promise<ResolvedConnectorInstallation> {
  const parsed = createConnectorInstallationBodySchema(catalog).safeParse(installation.body);
  if (!parsed.success) {
    throw new ConnectorToolValidationError("Connector installation body is invalid");
  }
  const provider = catalog.find(({ key }) => key === providerKey);
  if (provider === undefined) throw new ConnectorProviderNotFoundError(providerKey);

  const connection = await db.connectorConnection.findFirst({
    where: { id: parsed.data.connectionId, orgId: context.orgId },
    select: {
      id: true,
      providerKey: true,
      authMode: true,
      label: true,
      config: true,
      ownerPrincipalId: true,
      revokedAt: true,
      refreshExhausted: true,
      owner: { select: { id: true, kind: true, deactivatedAt: true } },
    },
  });
  if (connection === null) throw new ConnectorConnectionNotFoundError();
  if (connection.providerKey !== provider.key || connection.authMode !== provider.authMode) {
    throw new ConnectorToolValidationError(
      "Connector installation and connection providers do not match",
    );
  }
  const auditBinding: ConnectorResolutionAuditBinding = {
    installationItemId: installation.id,
    connectionId: connection.id,
    credentialOwnerPrincipalId: connection.ownerPrincipalId,
    connectorKey: provider.key,
  };
  if (connection.revokedAt !== null) {
    throw Object.assign(
      new ConnectorReconnectRequiredError(connection.id, provider.key, "revoked"),
      { auditBinding },
    );
  }
  if (connection.refreshExhausted) {
    throw Object.assign(
      new ConnectorReconnectRequiredError(connection.id, provider.key, "refresh_exhausted"),
      { auditBinding },
    );
  }
  if (
    !credentialEligible({
      sessionScopeKind: context.scopeKind,
      requesterPrincipalId: context.requesterPrincipalId,
      installationScope: installation.scope,
      owner: connection.owner,
      provider,
    })
  ) {
    throw new ConnectorAccessDeniedError(installation.id, "credential_ineligible", auditBinding);
  }
  await assertInstallationAccess(db, context, installation, parsed.data, auditBinding);

  return {
    installationItemId: installation.id,
    installationScopeId: installation.scopeId,
    connectorKey: provider.key,
    connectionId: connection.id,
    credentialOwnerPrincipalId: connection.ownerPrincipalId,
    connectionLabel:
      connection.label ??
      connectorConnectionMetadataLabel(catalog, provider.key, connection.config) ??
      provider.displayName,
    connectionSource: connection.owner.kind === "human" ? "personal" : "organization",
    body: parsed.data,
    provider,
    tools: resolveInstallationTools(provider, parsed.data),
  };
}

/** Resolve one provider after committing to its narrowest installation. */
export async function resolveConnectorInstallation(
  db: Database,
  context: ConnectorResolutionContext,
  providerKey: string,
  catalog: ProviderCatalog = defaultCatalog,
): Promise<ResolvedConnectorInstallation> {
  const selected = (await selectedInstallations(db, context)).get(providerKey);
  if (selected === undefined) {
    throw new ConnectorToolNotAvailableError(`${providerKey}:*`);
  }
  return resolveSelectedInstallation(db, context, providerKey, selected, catalog);
}

/** Resolve all providers visible to discovery through the same access checks as execution. */
export async function resolveConnectorInstallations(
  db: Database,
  context: ConnectorResolutionContext,
  catalog: ProviderCatalog = defaultCatalog,
): Promise<ResolvedConnectorInstallation[]> {
  const selected = await selectedInstallations(db, context);
  const resolved: ResolvedConnectorInstallation[] = [];
  for (const [providerKey, installation] of selected) {
    try {
      resolved.push(
        await resolveSelectedInstallation(db, context, providerKey, installation, catalog),
      );
    } catch (error) {
      if (!omittedFromDiscovery(error)) throw error;
      log.debug("Connector installation omitted from discovery", {
        itemId: installation.id,
        connector: providerKey,
        reason: error instanceof Error ? error.name : typeof error,
      });
    }
  }
  return resolved;
}

/** Resolve one enabled tool and return its pinned installation/connection binding. */
export async function resolveConnectorTool(
  db: Database,
  context: ConnectorResolutionContext & { toolKey: string; catalog?: ProviderCatalog },
): Promise<ResolvedConnectorTool> {
  const { catalogKey, toolName } = parseToolKey(context.toolKey);
  const resolved = await resolveConnectorInstallation(
    db,
    context,
    catalogKey,
    context.catalog ?? defaultCatalog,
  );
  const tool = resolved.tools.find(({ name }) => name === toolName);
  if (tool === undefined) {
    throw new ConnectorToolNotAvailableError(
      context.toolKey,
      resolved.installationItemId,
      resolved,
    );
  }
  return {
    ...resolved,
    toolKey: context.toolKey,
    toolName,
    tool,
    ...(tool.description ? { description: tool.description } : {}),
    ...(tool.annotations ? { annotations: tool.annotations } : {}),
  };
}
