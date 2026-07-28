import type { ProviderDef } from "@trema/connectors";
import { interpolate, loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";

import type { ConnectorConnection, Prisma } from "#server/generated/prisma/client.js";
import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
  decryptEnvelope,
  encryptEnvelope,
} from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { ConnectorConnectionNotFoundError } from "#server/services/connectors/connect.js";
import {
  discoverMcpAuthServer,
  type ResolvedMcpClient,
  resolveExistingMcpClientRegistration,
} from "#server/services/connectors/mcp-oauth.js";
import {
  ConnectorProviderNotFoundError,
  emptyPlatformAppDirectory,
  type PlatformAppDirectory,
  resolveClientRegistration,
} from "#server/services/connectors/registrations.js";

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

const REDACTED = "[REDACTED]";

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The field names whose value is credential material. `token_type` is the one
 * deliberate exclusion: it names a scheme (`Bearer`) rather than a token, and
 * seeding a redactor with the word "Bearer" would splice `[REDACTED]` through
 * every provider body that mentions it.
 */
const CREDENTIAL_FIELD_PATTERN = /token|secret|password|assertion|credential|api[_-]?key/i;

/**
 * The shortest string worth treating as a secret. A one- or two-word value in a
 * credential field is far more likely to be a label than a token, and a short
 * pattern would corrupt unrelated text everywhere it happened to appear.
 */
const MINIMUM_SECRET_LENGTH = 8;

function credentialField(key: string): boolean {
  return key !== "token_type" && CREDENTIAL_FIELD_PATTERN.test(key);
}

function addSecret(output: Set<string>, value: unknown): void {
  if (typeof value === "string" && value.length >= MINIMUM_SECRET_LENGTH) output.add(value);
}

function collectKeyed(
  value: unknown,
  key: string,
  output: Set<string>,
  seen: WeakSet<object>,
): void {
  if (typeof value === "string") {
    if (credentialField(key)) addSecret(output, value);
    return;
  }
  if (typeof value !== "object" || value === null || seen.has(value)) return;
  seen.add(value);
  // A list inherits the field it sits under, so `{ tokens: [...] }` is still
  // credential material and `{ scopes: [...] }` is still not.
  if (Array.isArray(value)) {
    for (const entry of value) collectKeyed(entry, key, output, seen);
    return;
  }
  for (const [childKey, entry] of Object.entries(value)) {
    collectKeyed(entry, childKey, output, seen);
  }
}

/**
 * Seed a redactor from credential material, and from nothing else.
 *
 * A decrypted payload is not uniformly secret: it carries `token_type`,
 * granted scope URLs, a basic-auth username, an account label. Collecting every
 * string in it would turn those into redaction patterns, which corrupts the
 * provider bodies the proxy hands the model and can blank out the very error
 * code a caller needs. So the walk is by field name, with one exception in
 * either direction: a bare string is a secret the caller named outright — a
 * master key, a client secret, a computed `Authorization` header — and is taken
 * as given.
 */
export function collectCredentialStrings(value: unknown, output: Set<string>): void {
  if (typeof value === "string") {
    addSecret(output, value);
    return;
  }
  collectKeyed(value, "", output, new WeakSet<object>());
}

/**
 * A refresh holds the whole credential in clear text: the stored tokens, the
 * client secret that authenticates the exchange, and the tokens the provider
 * hands back. Anything leaving this module as a log line or an error string
 * goes through the redactor first, because a transport failure or a chatty
 * provider will happily echo the request body back at us.
 */
class CredentialRedactor {
  readonly #values = new Set<string>();

  add(value: unknown): void {
    collectCredentialStrings(value, this.#values);
  }

  text(value: string): string {
    let redacted = value;
    for (const secret of [...this.#values].sort((left, right) => right.length - left.length)) {
      if (secret.length > 0) redacted = redacted.split(secret).join(REDACTED);
    }
    return redacted;
  }

  contains(value: string): boolean {
    return [...this.#values].some((secret) => secret.length > 0 && value.includes(secret));
  }

  /** A log-safe one-liner for a thrown value — never the raw object. */
  describe(error: unknown): string {
    return this.text(errorSummary(error));
  }
}

function errorSummary(error: unknown, depth = 0): string {
  if (typeof error === "string") return error;
  if (typeof error === "number" || typeof error === "boolean") return String(error);
  const record = recordValue(error);
  if (!record) return "unknown error";
  const name =
    error instanceof Error ? error.name : typeof record.name === "string" ? record.name : "Error";
  const message =
    error instanceof Error
      ? error.message
      : typeof record.message === "string"
        ? record.message
        : "";
  const code = typeof record.code === "string" ? record.code : undefined;
  const cause =
    depth < 3 && record.cause !== undefined && record.cause !== null
      ? `; caused by ${errorSummary(record.cause, depth + 1)}`
      : "";
  return `${name}${code ? ` [${code}]` : ""}${message ? `: ${message}` : ""}${cause}`;
}

/**
 * A rethrown error travels to callers that log it with their own rules, so a
 * message that actually embeds a secret is scrubbed in place, stack included.
 * The error keeps its class and identity; untainted messages are left exactly
 * as they were.
 */
function redactErrorMessage(error: unknown, redactor: CredentialRedactor, depth = 0): void {
  if (depth > 3 || !(error instanceof Error)) return;
  if (redactor.contains(error.message)) {
    try {
      // V8 builds the stack string around the message header, so a tainted
      // message is in the stack too — and a stack is what most loggers print.
      if (typeof error.stack === "string") error.stack = redactor.text(error.stack);
      error.message = redactor.text(error.message);
    } catch {
      // A frozen error keeps its message; the log line is redacted regardless.
    }
  }
  redactErrorMessage(error.cause, redactor, depth + 1);
}

function credentialPayload(connection: ConnectorConnection, masterKey: string | undefined) {
  let value: unknown;
  try {
    value = decryptEnvelope<unknown>(connection.ciphertext, masterKey);
  } catch (error) {
    // Decryption failed, so no plaintext exists yet — but the key and the
    // envelope do, and a cipher error is free to quote either one.
    const redactor = new CredentialRedactor();
    redactor.add(masterKey);
    redactor.add(connection.ciphertext);
    log.error("Connector credential decryption failed", {
      connectionId: connection.id,
      error: redactor.describe(error),
    });
    redactErrorMessage(error, redactor);
    throw error;
  }
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

function safeCodeCandidate(value: unknown, redactor: CredentialRedactor): string | undefined {
  if (typeof value !== "string" || !/^[A-Za-z][A-Za-z0-9._:-]{0,127}$/.test(value)) {
    return undefined;
  }
  return redactor.contains(value) ? undefined : value;
}

function providerErrorCode(
  raw: Record<string, unknown> | undefined,
  redactor: CredentialRedactor,
): string | undefined {
  if (!raw) return undefined;
  const error = raw.error;
  return (
    safeCodeCandidate(error, redactor) ??
    safeCodeCandidate(recordValue(error)?.code, redactor) ??
    safeCodeCandidate(raw.code, redactor)
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
  redactor: CredentialRedactor,
): Promise<RefreshExchangeResult> {
  redactor.add(payload);
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
    redactor.add(clientId);
    redactor.add(clientSecret);
  } catch (error) {
    log.warn("Connector refresh request preparation failed", {
      connectionId: connection.id,
      provider: connection.providerKey,
      error: redactor.describe(error),
    });
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
  } catch (error) {
    log.warn("Connector refresh request preparation failed", {
      connectionId: connection.id,
      provider: connection.providerKey,
      error: redactor.describe(error),
    });
    return { ok: false };
  }

  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(endpoint, {
      method: "POST",
      headers,
      body,
      signal: AbortSignal.timeout(10_000),
    });
  } catch (error) {
    // A transport error routinely carries the request it failed on, and the
    // request is the refresh token.
    log.warn("Connector refresh token request failed", {
      connectionId: connection.id,
      provider: connection.providerKey,
      error: redactor.describe(error),
    });
    return { ok: false };
  }

  const raw = await parseResponseRecord(response);
  if (!response.ok) {
    // The failure body is not credential material and must not seed the
    // redactor: its `error` field is the code we are trying to keep.
    const code = providerErrorCode(raw, redactor);
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
  // The new tokens are secret from here on: everything downstream — the
  // encrypt, the update, the outer catch — can fail while holding them.
  redactor.add(raw);
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
  // One redactor spans the whole attempt: it collects the stored tokens here,
  // the client secret and the rotated tokens inside the exchange, and guards
  // the outer catch that sees failures from any of those stages.
  const redactor = new CredentialRedactor();
  redactor.add(initialPayload);
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
        redactor.add(payload);
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

        log.debug("Connector token refresh attempted", {
          connectionId: connection.id,
          provider: connection.providerKey,
        });
        const exchange = await exchangeRefreshToken(
          transaction,
          connection,
          payload,
          provider,
          input,
          now,
          redactor,
        );
        if (!exchange.ok) {
          const isNewFailureWindow = connection.refreshFailureStartedAt === null;
          const wasAlreadyExhausted = connection.refreshExhausted;
          const failureStartedAt = connection.refreshFailureStartedAt ?? now;
          const refreshExhausted =
            now.getTime() - failureStartedAt.getTime() >= REFRESH_FAILURE_BUDGET_MS;
          log.warn("Connector token refresh failed", {
            connectionId: connection.id,
            provider: connection.providerKey,
            ...(exchange.status !== undefined ? { status: exchange.status } : {}),
            ...(exchange.code !== undefined ? { reason: exchange.code } : {}),
          });
          if (isNewFailureWindow) {
            log.warn("Connector refresh failure window opened", {
              connectionId: connection.id,
              provider: connection.providerKey,
            });
          }
          if (refreshExhausted && !wasAlreadyExhausted) {
            log.warn("Connector connection marked invalid", {
              connectionId: connection.id,
              provider: connection.providerKey,
            });
          }
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

        if (connection.lastRefreshFailure !== null) {
          log.info("Connector refresh failure window closed", {
            connectionId: connection.id,
            provider: connection.providerKey,
          });
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
        log.info("Connector token refreshed", {
          connectionId: connection.id,
          provider: connection.providerKey,
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
      log.warn("Connector refresh lock timed out", { connectionId: input.connectionId });
      return resolveAfterLockTimeout(db, input, provider, now);
    }
    if (
      !(error instanceof CredentialDecryptionError) &&
      !(error instanceof CredentialEncryptionConfigError)
    ) {
      log.error("Connector token refresh failed unexpectedly", {
        connectionId: input.connectionId,
        error: redactor.describe(error),
      });
    }
    redactErrorMessage(error, redactor);
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
