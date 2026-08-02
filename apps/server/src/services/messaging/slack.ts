import { loadProviderCatalog } from "@trema/connectors";

import { encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { createBinding, deleteBinding, resolveLocation } from "#server/services/bindings/index.js";
import {
  ConnectorAccessDeniedError,
  ConnectorConnectionNotFoundError,
  ConnectorProviderNotFoundError,
  ConnectorReconnectRequiredError,
  ConnectorToolNotAvailableError,
  ConnectorToolValidationError,
  connectorConnectionCredentialHealth,
  emptyPlatformAppDirectory,
  listConnectorConnections,
  resolveClientRegistration,
  resolveConnectionCredential,
  resolveConnectorInstallation,
  startOAuthConnect,
} from "#server/services/connectors/index.js";

const SLACK_PROVIDER_KEY = "slack";
const slackProvider = loadProviderCatalog().find(({ key }) => key === SLACK_PROVIDER_KEY);

if (!slackProvider) throw new Error("Slack connector provider is missing from the catalog");

export const SLACK_BOT_SCOPES = [...slackProvider.auth.defaultScopes];
export const SLACK_USER_SCOPES = (slackProvider.auth.authorizationParams?.user_scope ?? "")
  .split(/[\s,]+/)
  .filter((scope) => scope.length > 0);
export const SLACK_EVENTS_PATH = "/api/v1/messaging/slack/events";
export const SLACK_INTERACTIONS_PATH = "/api/v1/messaging/slack/interactions";

type SlackRejectReason =
  | "not_installed"
  | "ambiguous_installation"
  | "installation_unavailable"
  | "enterprise_mismatch"
  | "location_unbound"
  | "identity_unlinked"
  | "personal_scopes_disabled"
  | "connector_mismatch"
  | "bot_event";

export class SlackMessagingValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackMessagingValidationError";
  }
}

export class SlackMessagingConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SlackMessagingConflictError";
  }
}

export class SlackInstallationNotFoundError extends Error {
  constructor() {
    super("Slack installation not found");
    this.name = "SlackInstallationNotFoundError";
  }
}

export class SlackUninstallError extends Error {
  constructor(message = "Slack rejected the uninstall request") {
    super(message);
    this.name = "SlackUninstallError";
  }
}

export class SlackRequestRejectedError extends Error {
  constructor(readonly reason: SlackRejectReason) {
    super("Slack request could not be resolved to an authorized Trema context");
    this.name = "SlackRequestRejectedError";
  }
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function stringField(value: unknown, key: string): string | null {
  const candidate = record(value)[key];
  return typeof candidate === "string" && candidate.length > 0 ? candidate : null;
}

function booleanField(value: unknown, key: string): boolean {
  return record(value)[key] === true;
}

function isConnectorResolutionRejection(error: unknown): boolean {
  return (
    error instanceof ConnectorAccessDeniedError ||
    error instanceof ConnectorConnectionNotFoundError ||
    error instanceof ConnectorProviderNotFoundError ||
    error instanceof ConnectorReconnectRequiredError ||
    error instanceof ConnectorToolNotAvailableError ||
    error instanceof ConnectorToolValidationError
  );
}

function assertSlackId(kind: string, value: string): string {
  const trimmed = value.trim();
  if (!/^[A-Z][A-Z0-9]{1,31}$/.test(trimmed)) {
    throw new SlackMessagingValidationError(`${kind} is not a valid Slack ID`);
  }
  return trimmed;
}

function assertThreadTs(value: string | undefined): string | undefined {
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  if (!/^\d{1,20}\.\d{1,20}$/.test(trimmed)) {
    throw new SlackMessagingValidationError("Thread timestamp is not valid");
  }
  return trimmed;
}

export function slackLocationRef(workspaceId: string, channelId: string): string {
  return `${assertSlackId("Workspace ID", workspaceId)}:${assertSlackId("Channel ID", channelId)}`;
}

export function slackExternalUserRef(workspaceId: string, userId: string): string {
  return `${assertSlackId("Workspace ID", workspaceId)}:${assertSlackId("User ID", userId)}`;
}

function parseSlackLocationRef(locationRef: string) {
  const separator = locationRef.indexOf(":");
  if (separator <= 0 || separator === locationRef.length - 1) return undefined;
  const workspaceId = locationRef.slice(0, separator);
  const channelId = locationRef.slice(separator + 1);
  try {
    return {
      workspaceId: assertSlackId("Workspace ID", workspaceId),
      channelId: assertSlackId("Channel ID", channelId),
    };
  } catch {
    return undefined;
  }
}

export function slackAppManifest(authBaseUrl: string) {
  const base = new URL(authBaseUrl);
  const endpoint = (path: string) => new URL(path, base).toString();
  return {
    display_information: {
      name: "Trema",
      description: "Run Trema from authorized Slack conversations.",
      background_color: "#111827",
    },
    features: {
      bot_user: {
        display_name: "Trema",
        always_online: false,
      },
    },
    oauth_config: {
      redirect_urls: [endpoint("/connect/callback")],
      scopes: { bot: SLACK_BOT_SCOPES, user: SLACK_USER_SCOPES },
      token_management_enabled: true,
    },
    settings: {
      event_subscriptions: {
        request_url: endpoint(SLACK_EVENTS_PATH),
        bot_events: [
          "app_mention",
          "app_uninstalled",
          "message.channels",
          "message.groups",
          "message.im",
          "message.mpim",
          "tokens_revoked",
        ],
      },
      interactivity: {
        is_enabled: true,
        request_url: endpoint(SLACK_INTERACTIONS_PATH),
      },
      org_deploy_enabled: false,
      socket_mode_enabled: false,
      token_rotation_enabled: true,
    },
  };
}

export interface StartSlackInstallationInput {
  orgId: string;
  scopeId: string;
  ownerPrincipalId: string;
  initiatedByPrincipalId: string;
  authBaseUrl: string;
  returnTo?: string;
  reconnectConnectionId?: string;
  masterKey?: string;
  platformApps?: Parameters<typeof startOAuthConnect>[1]["platformApps"];
  fetch?: typeof globalThis.fetch;
}

export async function startSlackInstallation(db: Database, input: StartSlackInstallationInput) {
  const scope = await db.scope.findFirst({
    where: { id: input.scopeId, orgId: input.orgId, kind: { in: ["org", "shared"] } },
    select: { id: true },
  });
  if (!scope) {
    throw new SlackMessagingValidationError(
      "Slack's default scope must be an organization or shared scope",
    );
  }
  if (input.reconnectConnectionId) {
    const existing = await db.connectorConnection.findFirst({
      where: {
        id: input.reconnectConnectionId,
        orgId: input.orgId,
        providerKey: SLACK_PROVIDER_KEY,
        ownerPrincipalId: input.ownerPrincipalId,
      },
      select: { id: true },
    });
    if (!existing) throw new SlackInstallationNotFoundError();
  }

  const result = await startOAuthConnect(db, {
    orgId: input.orgId,
    scopeId: scope.id,
    ownerPrincipalId: input.ownerPrincipalId,
    initiatedByPrincipalId: input.initiatedByPrincipalId,
    providerKey: SLACK_PROVIDER_KEY,
    authBaseUrl: input.authBaseUrl,
    providerScopes: SLACK_BOT_SCOPES,
    ...(input.returnTo ? { returnTo: input.returnTo } : {}),
    ...(input.reconnectConnectionId ? { reconnectConnectionId: input.reconnectConnectionId } : {}),
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.platformApps ? { platformApps: input.platformApps } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  await db.auditLog.create({
    data: {
      orgId: input.orgId,
      actorPrincipalId: input.initiatedByPrincipalId,
      action: input.reconnectConnectionId
        ? "messaging.slack.installation.reauthorize"
        : "messaging.slack.installation.start",
      subject: input.reconnectConnectionId ?? input.orgId,
      payload: {
        scopeId: scope.id,
        ...(input.reconnectConnectionId ? { connectionId: input.reconnectConnectionId } : {}),
      },
    },
  });
  return result;
}

export async function listSlackInstallations(
  db: Database,
  input: { orgId: string; ownerPrincipalId: string; masterKey?: string; now?: Date },
) {
  const [connections, configs] = await Promise.all([
    listConnectorConnections(
      db,
      input.orgId,
      SLACK_PROVIDER_KEY,
      input.now ?? new Date(),
      input.ownerPrincipalId,
      input.masterKey,
    ),
    db.connectorConnection.findMany({
      where: {
        orgId: input.orgId,
        providerKey: SLACK_PROVIDER_KEY,
        ownerPrincipalId: input.ownerPrincipalId,
      },
      select: { id: true, config: true },
    }),
  ]);
  const configById = new Map(configs.map(({ id, config }) => [id, config]));
  return connections.map((connection) => {
    const config = configById.get(connection.id);
    return {
      ...connection,
      providerKey: "slack" as const,
      workspaceId: stringField(config, "team.id"),
      workspaceName: stringField(config, "team.name"),
      enterpriseId: stringField(config, "enterprise.id"),
      enterpriseName: stringField(config, "enterprise.name"),
      botUserId: stringField(config, "bot_user_id"),
      appId: stringField(config, "app_id"),
      installerUserId: stringField(config, "authed_user.id"),
      isEnterpriseInstall: booleanField(config, "is_enterprise_install"),
    };
  });
}

export async function uninstallSlackInstallation(
  db: Database,
  input: {
    orgId: string;
    actorPrincipalId: string;
    ownerPrincipalId: string;
    connectionId: string;
    masterKey?: string;
    platformApps?: Parameters<typeof resolveConnectionCredential>[1]["platformApps"];
    fetch?: typeof globalThis.fetch;
  },
) {
  const connection = await db.connectorConnection.findFirst({
    where: {
      id: input.connectionId,
      orgId: input.orgId,
      ownerPrincipalId: input.ownerPrincipalId,
      providerKey: SLACK_PROVIDER_KEY,
      revokedAt: null,
    },
    select: { id: true, config: true },
  });
  if (!connection) throw new SlackInstallationNotFoundError();

  const resolved = await resolveConnectionCredential(db, {
    orgId: input.orgId,
    connectionId: input.connectionId,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.platformApps ? { platformApps: input.platformApps } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });
  let registration: Awaited<ReturnType<typeof resolveClientRegistration>>;
  try {
    registration = await resolveClientRegistration(
      db,
      input.orgId,
      SLACK_PROVIDER_KEY,
      input.platformApps ?? emptyPlatformAppDirectory,
      input.masterKey,
    );
  } catch (error) {
    log.warn("Slack uninstall request preparation failed", {
      connectionId: connection.id,
      error,
    });
    throw new SlackUninstallError("Slack app credentials are unavailable");
  }

  const credentialRaw = record(resolved.credential.raw);
  const authedUser = record(credentialRaw.authed_user);
  let userAccessToken = stringField(authedUser, "access_token");
  const userRefreshToken = stringField(authedUser, "refresh_token");
  const fetch = input.fetch ?? globalThis.fetch;

  if (userRefreshToken) {
    let refreshResponse: Response;
    try {
      refreshResponse = await fetch("https://slack.com/api/oauth.v2.access", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({
          client_id: registration.clientId,
          client_secret: registration.clientSecret,
          grant_type: "refresh_token",
          refresh_token: userRefreshToken,
        }),
        signal: AbortSignal.timeout(10_000),
      });
    } catch {
      // Fetch failures may retain the request body, including the refresh
      // token and client secret, so do not attach the transport error.
      log.warn("Slack user token refresh failed", { connectionId: connection.id });
      throw new SlackUninstallError("Slack user credential could not be refreshed");
    }
    const refreshResult = record(await refreshResponse.json().catch(() => undefined));
    userAccessToken = stringField(refreshResult, "access_token");
    if (!refreshResponse.ok || refreshResult.ok !== true || !userAccessToken) {
      log.warn("Slack user token refresh rejected", {
        connectionId: connection.id,
        status: refreshResponse.status,
      });
      throw new SlackUninstallError("Slack user credential could not be refreshed");
    }

    const rotatedUser = Object.fromEntries(
      Object.entries(refreshResult).filter(([key]) => key !== "ok" && key !== "error"),
    );
    const nextCredential = {
      ...resolved.credential,
      raw: {
        ...credentialRaw,
        authed_user: { ...authedUser, ...rotatedUser },
      },
    };
    const updated = await db.connectorConnection.updateMany({
      where: { id: connection.id, orgId: input.orgId, revokedAt: null },
      data: { ciphertext: encryptEnvelope(nextCredential, input.masterKey) },
    });
    if (updated.count === 0) throw new SlackInstallationNotFoundError();
  }

  if (!userAccessToken) {
    throw new SlackUninstallError("Slack must be reauthorized before it can be uninstalled");
  }

  let response: Response;
  try {
    response = await fetch("https://slack.com/api/apps.uninstall", {
      method: "POST",
      headers: {
        Accept: "application/json",
        Authorization: `Bearer ${userAccessToken}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: new URLSearchParams({
        client_id: registration.clientId,
        client_secret: registration.clientSecret,
      }),
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    // Fetch failures may retain the bearer token or client secret.
    log.warn("Slack uninstall request failed", { connectionId: connection.id });
    throw new SlackUninstallError();
  }
  let result: Record<string, unknown> = {};
  try {
    result = record(await response.json());
  } catch {
    // A provider response can contain credential material. Never include it in
    // an error or log record; the safe status is enough for diagnosis.
  }
  if (!response.ok || result.ok !== true) {
    log.warn("Slack uninstall request rejected", {
      connectionId: connection.id,
      status: response.status,
    });
    throw new SlackUninstallError();
  }

  const revokedAt = new Date();
  await db.$transaction(async (transaction) => {
    const updated = await transaction.connectorConnection.updateMany({
      where: { id: connection.id, orgId: input.orgId, revokedAt: null },
      data: { revokedAt },
    });
    if (updated.count === 0) throw new SlackInstallationNotFoundError();
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "messaging.slack.installation.uninstall",
        subject: connection.id,
        payload: { workspaceId: stringField(connection.config, "team.id") },
      },
    });
  });
  log.info("Slack installation uninstalled", { connectionId: connection.id });
  return { id: connection.id, revokedAt };
}

async function slackConnection(
  db: Database,
  input: { orgId: string; connectionId: string; workspaceId: string },
) {
  const connection = await db.connectorConnection.findFirst({
    where: {
      id: input.connectionId,
      orgId: input.orgId,
      providerKey: SLACK_PROVIDER_KEY,
      revokedAt: null,
      config: { path: ["team.id"], equals: input.workspaceId },
      owner: { kind: "agent", deactivatedAt: null },
    },
    select: { id: true },
  });
  if (!connection) throw new SlackInstallationNotFoundError();
  return connection;
}

export async function createSlackBinding(
  db: Database,
  input: {
    orgId: string;
    actorPrincipalId: string;
    connectionId: string;
    workspaceId: string;
    channelId: string;
    scopeId: string;
  },
) {
  const workspaceId = assertSlackId("Workspace ID", input.workspaceId);
  const channelId = assertSlackId("Channel ID", input.channelId);
  const [connection, scope, orgScope] = await Promise.all([
    slackConnection(db, { ...input, workspaceId }),
    db.scope.findFirst({
      where: { id: input.scopeId, orgId: input.orgId, kind: { in: ["org", "shared"] } },
      select: { id: true, kind: true },
    }),
    db.scope.findFirst({
      where: { orgId: input.orgId, kind: "org" },
      select: { id: true },
    }),
  ]);
  if (!scope || !orgScope) {
    throw new SlackMessagingValidationError(
      "Slack conversations can only be bound to an organization or shared scope",
    );
  }
  const scopeChain = scope.id === orgScope.id ? [orgScope.id] : [orgScope.id, scope.id];
  let installation: Awaited<ReturnType<typeof resolveConnectorInstallation>>;
  try {
    installation = await resolveConnectorInstallation(
      db,
      {
        orgId: input.orgId,
        scopeChain,
        scopeKind: scope.kind,
        requesterPrincipalId: input.actorPrincipalId,
      },
      SLACK_PROVIDER_KEY,
    );
  } catch (error) {
    if (isConnectorResolutionRejection(error)) {
      throw new SlackMessagingValidationError(
        "Slack is not available to the target scope through this installation",
      );
    }
    throw error;
  }
  if (installation.connectionId !== connection.id) {
    throw new SlackMessagingConflictError(
      "The target scope resolves to a different Slack workspace installation",
    );
  }
  return createBinding(db, {
    orgId: input.orgId,
    actorPrincipalId: input.actorPrincipalId,
    surface: SLACK_PROVIDER_KEY,
    locationRef: slackLocationRef(workspaceId, channelId),
    scopeId: scope.id,
  });
}

export async function listSlackBindings(db: Database, orgId: string) {
  const bindings = await db.binding.findMany({
    // Personal-DM bindings are implicit audit metadata, not administrator-
    // managed routing rules. Keeping them out also avoids exposing another
    // member's personal scope in the Messaging settings response.
    where: {
      orgId,
      surface: SLACK_PROVIDER_KEY,
      scope: { kind: { in: ["org", "shared"] } },
    },
    include: { scope: { select: { name: true, kind: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return bindings.flatMap((binding) => {
    const parsed = parseSlackLocationRef(binding.locationRef);
    return parsed ? [{ ...binding, ...parsed }] : [];
  });
}

export async function deleteSlackBinding(
  db: Database,
  input: { orgId: string; actorPrincipalId: string; bindingId: string },
) {
  const binding = await db.binding.findFirst({
    where: { id: input.bindingId, orgId: input.orgId, surface: SLACK_PROVIDER_KEY },
    select: { id: true },
  });
  if (!binding) throw new SlackInstallationNotFoundError();
  return deleteBinding(db, input);
}

export async function listSlackIdentityLinks(db: Database, orgId: string) {
  const links = await db.identityLink.findMany({
    where: { orgId, surface: SLACK_PROVIDER_KEY },
    include: { principal: { select: { id: true, displayName: true, deactivatedAt: true } } },
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return links.flatMap((link) => {
    const parsed = parseSlackLocationRef(link.externalUserId);
    return parsed
      ? [
          {
            ...link,
            workspaceId: parsed.workspaceId,
            userId: parsed.channelId,
          },
        ]
      : [];
  });
}

export async function setSlackIdentityLink(
  db: Database,
  input: {
    orgId: string;
    actorPrincipalId: string;
    workspaceId: string;
    userId: string;
    principalId: string;
  },
) {
  const workspaceId = assertSlackId("Workspace ID", input.workspaceId);
  const userId = assertSlackId("User ID", input.userId);
  const [workspace, principal] = await Promise.all([
    db.connectorConnection.findFirst({
      where: {
        orgId: input.orgId,
        providerKey: SLACK_PROVIDER_KEY,
        revokedAt: null,
        config: { path: ["team.id"], equals: workspaceId },
      },
      select: { id: true },
    }),
    db.principal.findFirst({
      where: {
        id: input.principalId,
        orgId: input.orgId,
        kind: "human",
        deactivatedAt: null,
      },
      select: { id: true },
    }),
  ]);
  if (!workspace) throw new SlackInstallationNotFoundError();
  if (!principal) throw new SlackMessagingValidationError("Trema member not found");
  const externalUserId = slackExternalUserRef(workspaceId, userId);
  const link = await db.$transaction(async (transaction) => {
    const link = await transaction.identityLink.upsert({
      where: {
        orgId_surface_externalUserId: {
          orgId: input.orgId,
          surface: SLACK_PROVIDER_KEY,
          externalUserId,
        },
      },
      create: {
        orgId: input.orgId,
        surface: SLACK_PROVIDER_KEY,
        externalUserId,
        principalId: principal.id,
      },
      update: { principalId: principal.id },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "messaging.slack.identity.set",
        subject: link.id,
        payload: { workspaceId, userId, principalId: principal.id },
      },
    });
    return link;
  });
  log.info("Slack identity link set", { identityLinkId: link.id, principalId: principal.id });
  return link;
}

export async function deleteSlackIdentityLink(
  db: Database,
  input: { orgId: string; actorPrincipalId: string; identityLinkId: string },
) {
  const link = await db.$transaction(async (transaction) => {
    const link = await transaction.identityLink.findFirst({
      where: { id: input.identityLinkId, orgId: input.orgId, surface: SLACK_PROVIDER_KEY },
    });
    if (!link) throw new SlackInstallationNotFoundError();
    await transaction.identityLink.delete({ where: { id: link.id } });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "messaging.slack.identity.delete",
        subject: link.id,
        payload: { externalUserId: link.externalUserId, principalId: link.principalId },
      },
    });
    return link;
  });
  log.info("Slack identity link removed", { identityLinkId: link.id });
  return link;
}

export interface ResolveSlackRequestInput {
  workspaceId: string;
  enterpriseId?: string;
  channelId: string;
  threadTs?: string;
  userId: string;
  directMessage?: boolean;
  masterKey?: string;
  platformApps?: Parameters<typeof resolveConnectionCredential>[1]["platformApps"];
  fetch?: typeof globalThis.fetch;
  now?: Date;
}

export async function resolveSlackRequest(db: Database, input: ResolveSlackRequestInput) {
  const workspaceId = assertSlackId("Workspace ID", input.workspaceId);
  const channelId = assertSlackId("Channel ID", input.channelId);
  const userId = assertSlackId("User ID", input.userId);
  const threadTs = assertThreadTs(input.threadTs);
  const candidates = await db.connectorConnection.findMany({
    where: {
      providerKey: SLACK_PROVIDER_KEY,
      revokedAt: null,
      config: { path: ["team.id"], equals: workspaceId },
      owner: { kind: "agent", deactivatedAt: null },
    },
    select: {
      id: true,
      orgId: true,
      authMode: true,
      ciphertext: true,
      config: true,
      revokedAt: true,
      refreshExhausted: true,
      ownerPrincipalId: true,
    },
  });
  if (candidates.length === 0) {
    const revoked = await db.connectorConnection.findFirst({
      where: {
        providerKey: SLACK_PROVIDER_KEY,
        config: { path: ["team.id"], equals: workspaceId },
      },
      select: { id: true },
    });
    throw new SlackRequestRejectedError(revoked ? "installation_unavailable" : "not_installed");
  }
  if (candidates.length !== 1) {
    log.warn("Slack workspace resolved ambiguously", { workspaceId, count: candidates.length });
    throw new SlackRequestRejectedError("ambiguous_installation");
  }
  const connection = candidates[0]!;
  const botUserId = stringField(connection.config, "bot_user_id");
  if (botUserId !== null && userId === botUserId) {
    throw new SlackRequestRejectedError("bot_event");
  }
  const storedEnterpriseId = stringField(connection.config, "enterprise.id");
  if (input.enterpriseId && storedEnterpriseId && input.enterpriseId !== storedEnterpriseId) {
    log.warn("Slack enterprise did not match installation", { workspaceId });
    throw new SlackRequestRejectedError("enterprise_mismatch");
  }
  const credentialHealth = connectorConnectionCredentialHealth(connection, input.masterKey);
  if (!credentialHealth.credentialAvailable || connection.refreshExhausted) {
    throw new SlackRequestRejectedError("installation_unavailable");
  }
  try {
    await resolveConnectionCredential(db, {
      orgId: connection.orgId,
      connectionId: connection.id,
      ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      ...(input.platformApps ? { platformApps: input.platformApps } : {}),
      ...(input.fetch ? { fetch: input.fetch } : {}),
      ...(input.now ? { now: input.now } : {}),
    });
  } catch (error) {
    if (error instanceof ConnectorReconnectRequiredError) {
      throw new SlackRequestRejectedError("installation_unavailable");
    }
    throw error;
  }
  const locationRef = slackLocationRef(workspaceId, channelId);
  const externalUserId = slackExternalUserRef(workspaceId, userId);
  const identity = await db.identityLink.findUnique({
    where: {
      orgId_surface_externalUserId: {
        orgId: connection.orgId,
        surface: SLACK_PROVIDER_KEY,
        externalUserId,
      },
    },
    include: { principal: true },
  });
  if (identity?.principal.kind !== "human" || identity.principal.deactivatedAt !== null) {
    throw new SlackRequestRejectedError("identity_unlinked");
  }

  const location = await resolveLocation(db, {
    orgId: connection.orgId,
    surface: SLACK_PROVIDER_KEY,
    locationRef,
    ...(input.directMessage ? { dm: { externalUserId } } : {}),
  });
  if (location.kind === "unbound") throw new SlackRequestRejectedError("location_unbound");
  if (location.kind === "unlinked") throw new SlackRequestRejectedError("identity_unlinked");
  if (location.kind === "personal_disabled") {
    throw new SlackRequestRejectedError("personal_scopes_disabled");
  }

  const orgScope = await db.scope.findFirst({
    where: { orgId: connection.orgId, kind: "org" },
    select: { id: true },
  });
  if (!orgScope) throw new SlackRequestRejectedError("connector_mismatch");
  const scopeChain =
    location.scope.id === orgScope.id ? [orgScope.id] : [orgScope.id, location.scope.id];
  let installation: Awaited<ReturnType<typeof resolveConnectorInstallation>>;
  try {
    installation = await resolveConnectorInstallation(
      db,
      {
        orgId: connection.orgId,
        scopeChain,
        scopeKind: location.scope.kind,
        requesterPrincipalId: identity.principal.id,
      },
      SLACK_PROVIDER_KEY,
    );
  } catch (error) {
    if (isConnectorResolutionRejection(error)) {
      throw new SlackRequestRejectedError("connector_mismatch");
    }
    throw error;
  }
  if (
    installation.connectionId !== connection.id ||
    installation.credentialOwnerPrincipalId !== connection.ownerPrincipalId
  ) {
    throw new SlackRequestRejectedError("connector_mismatch");
  }

  const conversationThreadRef = threadTs ?? "";
  const [binding, conversation, run] = await Promise.all([
    db.binding.findUnique({
      where: {
        orgId_surface_locationRef: {
          orgId: connection.orgId,
          surface: SLACK_PROVIDER_KEY,
          locationRef,
        },
      },
    }),
    db.conversation.findUnique({
      where: {
        orgId_surface_locationRef_threadRef: {
          orgId: connection.orgId,
          surface: SLACK_PROVIDER_KEY,
          locationRef,
          threadRef: conversationThreadRef,
        },
      },
      select: { id: true },
    }),
    db.agentRun.findFirst({
      where: {
        orgId: connection.orgId,
        session: {
          surface: SLACK_PROVIDER_KEY,
          locationRef,
          threadRef: threadTs ?? null,
        },
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      select: { id: true },
    }),
  ]);

  return {
    orgId: connection.orgId,
    connectionId: connection.id,
    installationItemId: installation.installationItemId,
    credentialOwnerPrincipalId: installation.credentialOwnerPrincipalId,
    botUserId,
    scopeId: location.scope.id,
    requesterPrincipalId: identity.principal.id,
    requesterDisplayName: identity.principal.displayName,
    bindingId: binding?.id ?? null,
    conversationId: conversation?.id ?? null,
    runId: run?.id ?? null,
    workspaceId,
    enterpriseId: storedEnterpriseId,
    channelId,
    threadTs: threadTs ?? null,
    userId,
    locationRef,
    externalUserId,
  };
}
