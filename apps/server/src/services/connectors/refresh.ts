import type { ProviderDef } from "@trema/connectors";
import { interpolate, loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";

import type { ConnectorConnection, Prisma } from "#/generated/prisma/client.js";
import { decryptEnvelope, encryptEnvelope } from "#/lib/crypto/index.js";
import type { Database } from "#/lib/db/index.js";
import { ConnectorConnectionNotFoundError } from "#/services/connectors/connect.js";
import {
  discoverMcpAuthServer,
  type ResolvedMcpClient,
  resolveExistingMcpClientRegistration,
} from "#/services/connectors/mcp-oauth.js";
import {
  ConnectorProviderNotFoundError,
  emptyPlatformAppDirectory,
  type PlatformAppDirectory,
  resolveClientRegistration,
} from "#/services/connectors/registrations.js";

const defaultCatalog = loadProviderCatalog();

export const DEFAULT_TOKEN_EXPIRATION_BUFFER_SECONDS = 15 * 60;
export const CONSERVATIVE_TOKEN_LIFETIME_SECONDS = 60 * 60;
export const REFRESH_FAILURE_COOLDOWN_MS = 30 * 1000;
export const REFRESH_FAILURE_BUDGET_MS = 4 * 24 * 60 * 60 * 1000;

const REFRESH_TRANSACTION_TIMEOUT_MS = 30_000;
const REFRESH_LOCK_TIMEOUT_MS = 5_000;

export type ConnectionCredentialPayload = Record<string, unknown> & {
  accessToken?: unknown;
  refreshToken?: unknown;
  raw?: unknown;
};

export type ConnectorReconnectReason =
  | "revoked"
  | "expired"
  | "refresh_exhausted"
  | "missing_client_registration";

export class ConnectorReconnectRequiredError extends Error {
  readonly code = "reconnect_needed";
  readonly reconnectNeeded = true;

  constructor(
    readonly connectionId: string,
    readonly providerKey: string,
    readonly reason: ConnectorReconnectReason,
    readonly providerStatus?: number,
    readonly providerCode?: string,
  ) {
    const providerDetail = [
      providerStatus === undefined ? undefined : `status ${providerStatus}`,
      providerCode === undefined ? undefined : `code ${providerCode}`,
    ]
      .filter((value): value is string => value !== undefined)
      .join(", ");
    super(
      `Connector connection requires reconnection${
        providerDetail.length > 0 ? ` (provider ${providerDetail})` : ""
      }`,
    );
    this.name = "ConnectorReconnectRequiredError";
  }
}

export interface ResolvedConnectionCredential {
  connectionId: string;
  providerKey: string;
  mode: string;
  credential: ConnectionCredentialPayload;
  config: Record<string, string | number | boolean>;
  expiresAt: Date | null;
}

export interface ResolveConnectionCredentialInput {
  orgId: string;
  connectionId: string;
  masterKey?: string;
  catalog?: ProviderCatalog;
  platformApps?: PlatformAppDirectory;
  fetch?: typeof globalThis.fetch;
  now?: Date;
}

interface SafeProviderFailure {
  status?: number;
  code?: string;
}

interface RefreshExchangeSuccess {
  ok: true;
  raw: Record<string, unknown>;
  accessToken: string;
  refreshToken?: string;
  expiresAt: Date;
}

interface RefreshExchangeFailure extends SafeProviderFailure {
  ok: false;
}

type RefreshExchangeResult = RefreshExchangeSuccess | RefreshExchangeFailure;

const inFlightRefreshes = new Map<string, Promise<ResolvedConnectionCredential>>();

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function credentialPayload(connection: ConnectorConnection, masterKey: string | undefined) {
  const value = decryptEnvelope<unknown>(connection.ciphertext, masterKey);
  const payload = recordValue(value);
  if (!payload) {
    throw new ConnectorReconnectRequiredError(connection.id, connection.providerKey, "expired");
  }
  return payload as ConnectionCredentialPayload;
}

function primitiveConfig(value: Prisma.JsonValue): Record<string, string | number | boolean> {
  const record = recordValue(value);
  if (!record) return {};
  return Object.fromEntries(
    Object.entries(record).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function refreshToken(payload: ConnectionCredentialPayload): string | undefined {
  const value = payload.refreshToken ?? recordValue(payload.raw)?.refresh_token;
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function effectiveExpiration(
  connection: ConnectorConnection,
  payload: ConnectionCredentialPayload,
): Date | null {
  if (connection.expiresAt) return connection.expiresAt;
  if (!refreshToken(payload)) return null;
  const issuedAt = connection.lastRefreshSuccess ?? connection.updatedAt ?? connection.createdAt;
  return new Date(issuedAt.getTime() + CONSERVATIVE_TOKEN_LIFETIME_SECONDS * 1000);
}

function refreshMarginMs(provider: ProviderDef): number {
  return (provider.auth.tokenExpirationBuffer ?? DEFAULT_TOKEN_EXPIRATION_BUFFER_SECONDS) * 1000;
}

export function connectionNeedsRefresh(
  connection: ConnectorConnection,
  payload: ConnectionCredentialPayload,
  provider: ProviderDef,
  now: Date,
): boolean {
  if (connection.mode !== "oauth2_code" && connection.mode !== "mcp_oauth") return false;
  const expiration = effectiveExpiration(connection, payload);
  return expiration !== null && now.getTime() > expiration.getTime() - refreshMarginMs(provider);
}

function expirationHasPassed(
  connection: ConnectorConnection,
  payload: ConnectionCredentialPayload,
  now: Date,
): boolean {
  const expiration = effectiveExpiration(connection, payload);
  return expiration !== null && expiration <= now;
}

function inCooldown(connection: ConnectorConnection, now: Date): boolean {
  return (
    connection.lastRefreshFailure !== null &&
    now.getTime() - connection.lastRefreshFailure.getTime() < REFRESH_FAILURE_COOLDOWN_MS
  );
}

function assertConnectionAvailable(
  connection: ConnectorConnection,
  payload: ConnectionCredentialPayload,
  now: Date,
): void {
  if (connection.revokedAt) {
    throw new ConnectorReconnectRequiredError(connection.id, connection.providerKey, "revoked");
  }
  if (connection.refreshExhausted) {
    throw new ConnectorReconnectRequiredError(
      connection.id,
      connection.providerKey,
      "refresh_exhausted",
    );
  }
  if (
    (connection.mode === "oauth2_code" || connection.mode === "mcp_oauth") &&
    expirationHasPassed(connection, payload, now) &&
    !refreshToken(payload)
  ) {
    throw new ConnectorReconnectRequiredError(connection.id, connection.providerKey, "expired");
  }
}

function resolvedCredential(
  connection: ConnectorConnection,
  payload: ConnectionCredentialPayload,
): ResolvedConnectionCredential {
  return {
    connectionId: connection.id,
    providerKey: connection.providerKey,
    mode: connection.mode,
    credential: payload,
    config: primitiveConfig(connection.config),
    expiresAt: effectiveExpiration(connection, payload),
  };
}

function providerFrom(catalog: ProviderCatalog, providerKey: string): ProviderDef | undefined {
  return catalog.find((provider) => provider.key === providerKey);
}

function tokenEndpointUrl(
  provider: ProviderDef,
  config: Record<string, string | number | boolean>,
): string | undefined {
  const endpoint = provider.auth.refreshUrl ?? provider.auth.tokenUrl;
  return endpoint
    ? interpolate(endpoint, {
        ...(Object.keys(config).length > 0 ? { config } : {}),
      })
    : undefined;
}

function safeCodeCandidate(value: unknown, sensitiveValues: readonly string[]): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return undefined;
  }
  return sensitiveValues.some((secret) => secret.length > 0 && value.includes(secret))
    ? undefined
    : value;
}

function providerErrorCode(
  raw: Record<string, unknown> | undefined,
  sensitiveValues: readonly string[],
): string | undefined {
  if (!raw) return undefined;
  const error = raw.error;
  return (
    safeCodeCandidate(error, sensitiveValues) ??
    safeCodeCandidate(recordValue(error)?.code, sensitiveValues) ??
    safeCodeCandidate(raw.code, sensitiveValues)
  );
}

function numericExpiresIn(raw: Record<string, unknown>): number | undefined {
  const value = raw.expires_in;
  const parsed =
    typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : undefined;
}

function applyOAuthClientAuthentication(
  provider: ProviderDef,
  body: URLSearchParams,
  headers: Headers,
  client: { clientId: string; clientSecret: string },
): void {
  if (provider.auth.tokenRequestAuthMethod === "body") {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
    return;
  }
  if (provider.auth.tokenRequestAuthMethod === "private_key_jwt") {
    throw new Error("unsupported client authentication");
  }
  headers.set(
    "Authorization",
    `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`, "utf8").toString("base64")}`,
  );
}

function applyMcpClientAuthentication(
  body: URLSearchParams,
  headers: Headers,
  client: ResolvedMcpClient,
): void {
  const method =
    client.tokenEndpointAuthMethod ?? (client.clientSecret ? "client_secret_basic" : "none");
  if (method === "none") {
    body.set("client_id", client.clientId);
    return;
  }
  if (method === "client_secret_post" && client.clientSecret) {
    body.set("client_id", client.clientId);
    body.set("client_secret", client.clientSecret);
    return;
  }
  if (method === "client_secret_basic" && client.clientSecret) {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`, "utf8").toString("base64")}`,
    );
    return;
  }
  throw new Error("unsupported client authentication");
}

async function parseResponseRecord(
  response: Response,
): Promise<Record<string, unknown> | undefined> {
  try {
    return recordValue(await response.json());
  } catch {
    return undefined;
  }
}

async function exchangeRefreshToken(
  transaction: Prisma.TransactionClient,
  connection: ConnectorConnection,
  payload: ConnectionCredentialPayload,
  provider: ProviderDef,
  input: ResolveConnectionCredentialInput,
  now: Date,
): Promise<RefreshExchangeResult> {
  const existingRefreshToken = refreshToken(payload);
  if (!existingRefreshToken) return { ok: false };

  const config = primitiveConfig(connection.config);
  const platformApps = input.platformApps ?? emptyPlatformAppDirectory;
  let endpoint = tokenEndpointUrl(provider, config);
  let resource: string | undefined;
  let clientId: string;
  let clientSecret: string | undefined;
  let mcpClient: ResolvedMcpClient | undefined;

  try {
    if (connection.mode === "mcp_oauth") {
      if (provider.transport.type !== "mcp") return { ok: false };
      resource = interpolate(provider.transport.serverUrl, {
        ...(Object.keys(config).length > 0 ? { config } : {}),
      });
      if (!endpoint) {
        endpoint = (await discoverMcpAuthServer(resource, input.fetch)).tokenEndpoint;
      }
      mcpClient = await resolveExistingMcpClientRegistration(transaction, {
        orgId: connection.orgId,
        providerKey: connection.providerKey,
        platformApps,
        ...(input.masterKey ? { masterKey: input.masterKey } : {}),
      });
      if (!mcpClient) return { ok: false };
      clientId = mcpClient.clientId;
      clientSecret = mcpClient.clientSecret;
    } else {
      if (!endpoint) return { ok: false };
      const client = await resolveClientRegistration(
        transaction,
        connection.orgId,
        connection.providerKey,
        platformApps,
        input.masterKey,
      );
      clientId = client.clientId;
      clientSecret = client.clientSecret;
    }
  } catch {
    return { ok: false };
  }

  if (!endpoint) return { ok: false };
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: existingRefreshToken,
  });
  if (resource) body.set("resource", resource);
  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });

  try {
    if (mcpClient) {
      applyMcpClientAuthentication(body, headers, mcpClient);
    } else if (clientSecret !== undefined) {
      applyOAuthClientAuthentication(provider, body, headers, { clientId, clientSecret });
    } else {
      return { ok: false };
    }
  } catch {
    return { ok: false };
  }

  const sensitiveValues = [
    existingRefreshToken,
    typeof payload.accessToken === "string" ? payload.accessToken : "",
    clientId,
    clientSecret ?? "",
  ];
  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch {
    return { ok: false };
  }

  const raw = await parseResponseRecord(response);
  if (!response.ok) {
    const code = providerErrorCode(raw, sensitiveValues);
    return {
      ok: false,
      status: response.status,
      ...(code ? { code } : {}),
    };
  }
  const accessToken = raw?.access_token;
  if (!raw || typeof accessToken !== "string" || accessToken.length === 0) {
    return { ok: false, status: response.status };
  }
  const rotatedRefreshToken =
    typeof raw.refresh_token === "string" && raw.refresh_token.length > 0
      ? raw.refresh_token
      : undefined;
  const expiresIn = numericExpiresIn(raw) ?? CONSERVATIVE_TOKEN_LIFETIME_SECONDS;
  return {
    ok: true,
    raw,
    accessToken,
    ...(rotatedRefreshToken ? { refreshToken: rotatedRefreshToken } : {}),
    expiresAt: new Date(now.getTime() + expiresIn * 1000),
  };
}

function hasNestedErrorCode(error: unknown, expected: string, depth = 0): boolean {
  if (depth > 4 || typeof error !== "object" || error === null) return false;
  const record = error as Record<string, unknown>;
  return (
    record.code === expected ||
    hasNestedErrorCode(record.cause, expected, depth + 1) ||
    hasNestedErrorCode(record.meta, expected, depth + 1)
  );
}

function isDistributedLockTimeout(error: unknown): boolean {
  return hasNestedErrorCode(error, "55P03") || hasNestedErrorCode(error, "P2028");
}

async function connectionRow(
  db: Pick<Database, "connectorConnection">,
  orgId: string,
  connectionId: string,
): Promise<ConnectorConnection> {
  const connection = await db.connectorConnection.findFirst({
    where: { id: connectionId, orgId },
  });
  if (!connection) throw new ConnectorConnectionNotFoundError();
  return connection;
}

function reconnectFromFailure(
  connection: ConnectorConnection,
  failure: SafeProviderFailure,
  reason: ConnectorReconnectReason,
): ConnectorReconnectRequiredError {
  return new ConnectorReconnectRequiredError(
    connection.id,
    connection.providerKey,
    reason,
    failure.status,
    failure.code,
  );
}

async function resolveAfterLockTimeout(
  db: Database,
  input: ResolveConnectionCredentialInput,
  provider: ProviderDef,
  now: Date,
): Promise<ResolvedConnectionCredential> {
  // A timed-out contender still performs the mandated double-check. It never
  // spends the refresh token without the lock; a still-valid token can serve
  // this call, while an expired one asks the caller to reconnect.
  const connection = await connectionRow(db, input.orgId, input.connectionId);
  const payload = credentialPayload(connection, input.masterKey);
  assertConnectionAvailable(connection, payload, now);
  if (
    !connectionNeedsRefresh(connection, payload, provider, now) ||
    !expirationHasPassed(connection, payload, now)
  ) {
    return resolvedCredential(connection, payload);
  }
  throw new ConnectorReconnectRequiredError(connection.id, connection.providerKey, "expired");
}

async function resolveConnectionCredentialInternal(
  db: Database,
  input: ResolveConnectionCredentialInput,
): Promise<ResolvedConnectionCredential> {
  const now = input.now ?? new Date();
  const catalog = input.catalog ?? defaultCatalog;
  const initial = await connectionRow(db, input.orgId, input.connectionId);
  const initialPayload = credentialPayload(initial, input.masterKey);
  assertConnectionAvailable(initial, initialPayload, now);
  const provider = providerFrom(catalog, initial.providerKey);

  if (!provider) throw new ConnectorProviderNotFoundError(initial.providerKey);
  if (!connectionNeedsRefresh(initial, initialPayload, provider, now)) {
    return resolvedCredential(initial, initialPayload);
  }
  if (inCooldown(initial, now)) {
    if (expirationHasPassed(initial, initialPayload, now)) {
      throw new ConnectorReconnectRequiredError(initial.id, initial.providerKey, "expired");
    }
    return resolvedCredential(initial, initialPayload);
  }

  try {
    const result = await db.$transaction(
      async (transaction) => {
        // PostgreSQL transaction-scoped advisory locks give every process the
        // same connection-id mutex. lock_timeout plus the interactive
        // transaction timeout bounds its TTL even if a worker disappears.
        await transaction.$executeRawUnsafe(
          `SET LOCAL lock_timeout = '${REFRESH_LOCK_TIMEOUT_MS}ms'`,
        );
        await transaction.$executeRaw`
          SELECT pg_advisory_xact_lock(hashtextextended(${input.connectionId}, 0))
        `;

        // Double-check only after holding the distributed lock. A different
        // worker may have rotated the one-use refresh token while we waited.
        const connection = await connectionRow(transaction, input.orgId, input.connectionId);
        const payload = credentialPayload(connection, input.masterKey);
        assertConnectionAvailable(connection, payload, now);
        if (!connectionNeedsRefresh(connection, payload, provider, now)) {
          return { state: "resolved" as const, connection, payload };
        }
        if (inCooldown(connection, now)) {
          return { state: "cooldown" as const, connection, payload };
        }
        if (!refreshToken(payload)) {
          return { state: "missing_refresh_token" as const, connection, payload };
        }

        const exchange = await exchangeRefreshToken(
          transaction,
          connection,
          payload,
          provider,
          input,
          now,
        );
        if (!exchange.ok) {
          const failureStartedAt = connection.refreshFailureStartedAt ?? now;
          const refreshExhausted =
            now.getTime() - failureStartedAt.getTime() >= REFRESH_FAILURE_BUDGET_MS;
          const failed = await transaction.connectorConnection.update({
            where: { id: connection.id },
            data: {
              lastRefreshFailure: now,
              refreshFailureStartedAt: failureStartedAt,
              refreshAttempts: { increment: 1 },
              refreshExhausted,
            },
          });
          return {
            state: "failed" as const,
            connection: failed,
            payload,
            failure: exchange satisfies SafeProviderFailure,
          };
        }

        const nextPayload: ConnectionCredentialPayload = {
          accessToken: exchange.accessToken,
          refreshToken: exchange.refreshToken ?? refreshToken(payload),
          raw: exchange.raw,
        };
        const refreshed = await transaction.connectorConnection.update({
          where: { id: connection.id },
          data: {
            ciphertext: encryptEnvelope(nextPayload, input.masterKey),
            expiresAt: exchange.expiresAt,
            lastRefreshSuccess: now,
            lastRefreshFailure: null,
            refreshFailureStartedAt: null,
            refreshAttempts: 0,
            refreshExhausted: false,
          },
        });
        return { state: "refreshed" as const, connection: refreshed, payload: nextPayload };
      },
      { maxWait: REFRESH_LOCK_TIMEOUT_MS, timeout: REFRESH_TRANSACTION_TIMEOUT_MS },
    );

    if (result.state === "resolved" || result.state === "refreshed") {
      return resolvedCredential(result.connection, result.payload);
    }
    if (result.state === "cooldown") {
      if (expirationHasPassed(result.connection, result.payload, now)) {
        throw new ConnectorReconnectRequiredError(
          result.connection.id,
          result.connection.providerKey,
          "expired",
        );
      }
      return resolvedCredential(result.connection, result.payload);
    }
    if (result.state === "missing_refresh_token") {
      if (expirationHasPassed(result.connection, result.payload, now)) {
        throw new ConnectorReconnectRequiredError(
          result.connection.id,
          result.connection.providerKey,
          "expired",
        );
      }
      return resolvedCredential(result.connection, result.payload);
    }
    if (result.connection.refreshExhausted) {
      throw reconnectFromFailure(result.connection, result.failure, "refresh_exhausted");
    }
    if (expirationHasPassed(result.connection, result.payload, now)) {
      throw reconnectFromFailure(result.connection, result.failure, "expired");
    }
    return resolvedCredential(result.connection, result.payload);
  } catch (error) {
    if (error instanceof ConnectorReconnectRequiredError) throw error;
    if (isDistributedLockTimeout(error)) {
      return resolveAfterLockTimeout(db, input, provider, now);
    }
    throw error;
  }
}

export function resolveConnectionCredential(
  db: Database,
  input: ResolveConnectionCredentialInput,
): Promise<ResolvedConnectionCredential> {
  const inFlightKey = `${input.orgId}\0${input.connectionId}`;
  const existing = inFlightRefreshes.get(inFlightKey);
  if (existing) return existing;

  const resolving = resolveConnectionCredentialInternal(db, input).finally(() => {
    if (inFlightRefreshes.get(inFlightKey) === resolving) {
      inFlightRefreshes.delete(inFlightKey);
    }
  });
  inFlightRefreshes.set(inFlightKey, resolving);
  return resolving;
}
