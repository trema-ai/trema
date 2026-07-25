import { createHash, randomBytes } from "node:crypto";
import type { FieldDescriptor, ProviderDef } from "@trema/connectors";
import {
  interpolate,
  loadProviderCatalog,
  type ProviderCatalog,
  providerHookRegistry,
} from "@trema/connectors";
import type { ConnectorOAuthState, Prisma } from "#server/generated/prisma/client.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  buildMcpAuthorizationRequest,
  discoverMcpAuthServer,
  exchangeMcpAuthorizationCode,
  resolveMcpClientRegistration,
  resolveStoredMcpClientRegistration,
} from "#server/services/connectors/mcp-oauth.js";
import {
  ConnectorProviderNotFoundError,
  emptyPlatformAppDirectory,
  type PlatformAppDirectory,
  resolveClientRegistration,
  resolveStoredClientRegistration,
} from "#server/services/connectors/registrations.js";

const defaultCatalog = loadProviderCatalog();
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;
const CONSERVATIVE_OAUTH_TOKEN_LIFETIME_MS = 60 * 60 * 1000;

export type ConnectorFetch = typeof globalThis.fetch;

export class ConnectorInstallationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorInstallationError";
  }
}

export class UnsupportedConnectorAuthModeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedConnectorAuthModeError";
  }
}

export class OAuthStateSingleUseError extends Error {
  readonly code = "invalid_or_consumed_state";

  constructor() {
    super("OAuth state is invalid or has already been consumed");
    this.name = "OAuthStateSingleUseError";
  }
}

export class OAuthStateExpiredError extends Error {
  readonly code = "expired_state";

  constructor() {
    super("OAuth state has expired");
    this.name = "OAuthStateExpiredError";
  }
}

export class OAuthTokenExchangeError extends Error {
  readonly code = "token_exchange_failed";

  constructor(cause?: unknown) {
    const detail = cause instanceof Error ? `: ${cause.message}` : "";
    super(`OAuth token exchange failed${detail}`, { cause });
    this.name = "OAuthTokenExchangeError";
  }
}

export class StaticCredentialValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StaticCredentialValidationError";
  }
}

export class CredentialVerificationError extends Error {
  readonly code = "verification_failed";

  constructor(message = "Connector credential verification failed") {
    super(message);
    this.name = "CredentialVerificationError";
  }
}

export class ConnectorCatalogDefectError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConnectorCatalogDefectError";
  }
}

export class ConnectorConnectionNotFoundError extends Error {
  constructor() {
    super("Connector connection not found");
    this.name = "ConnectorConnectionNotFoundError";
  }
}

function providerFrom(catalog: ProviderCatalog, providerKey: string): ProviderDef {
  const provider = catalog.find(({ key }) => key === providerKey);
  if (!provider) throw new ConnectorProviderNotFoundError(providerKey);
  return provider;
}

function connectionConfig(value: Prisma.JsonValue): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(([, candidate]) => candidate !== undefined),
  );
}

function interpolationConfig(value: Prisma.JsonValue): Record<string, string | number | boolean> {
  return Object.fromEntries(
    Object.entries(connectionConfig(value)).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function declaredConfig(provider: ProviderDef, value: Prisma.JsonValue): Record<string, unknown> {
  const stored = connectionConfig(value);
  return Object.fromEntries(
    Object.keys(provider.configFields).flatMap((name) =>
      stored[name] === undefined ? [] : [[name, stored[name]]],
    ),
  );
}

function submittedProviderScopes(body: unknown): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const scopes = (body as { providerScopes?: unknown }).providerScopes;
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
}

export function requestedOAuthScopes(provider: ProviderDef, input: unknown): string[] {
  const override = submittedProviderScopes(input);
  return override.length > 0 ? override : [...provider.auth.defaultScopes];
}

// Parse the scopes a token response actually granted. Providers return the
// granted scope set as a single delimited string; split on the provider's
// separator, falling back to both spaces and commas, and drop empties. When
// the response omits `scope`, treat the requested scopes as granted.
export function parseGrantedScopes(
  raw: unknown,
  requested: readonly string[],
  scopeSeparator?: string,
): string[] {
  if (typeof raw !== "string" || raw.trim() === "") return [...requested];
  const pattern = scopeSeparator
    ? new RegExp(`[${scopeSeparator.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s]+`)
    : /[\s,]+/;
  const parsed = raw
    .split(pattern)
    .map((scope) => scope.trim())
    .filter((scope) => scope.length > 0);
  return parsed.length > 0 ? parsed : [...requested];
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function connectorCallbackUrl(authBaseUrl: string): string {
  return new URL("/connect/callback", authBaseUrl).toString();
}

export interface StartOAuthConnectInput {
  orgId: string;
  principalId: string;
  providerKey: string;
  authBaseUrl: string;
  masterKey?: string;
  returnTo?: string;
  config?: Readonly<Record<string, string | number | boolean>>;
  providerScopes?: readonly string[];
  label?: string;
  reconnectConnectionId?: string;
  catalog?: ProviderCatalog;
  platformApps?: PlatformAppDirectory;
  // Used by mcp_oauth discovery, dynamic client registration, and (via the
  // callback) token exchange. oauth2_code ignores it.
  fetch?: ConnectorFetch;
  now?: Date;
}

export interface BuildAuthorizationUrlInput {
  provider: ProviderDef;
  clientId: string;
  authBaseUrl: string;
  state: string;
  codeVerifier: string;
  // The scopes to request; when omitted or empty, the provider's defaultScopes
  // are used.
  scopes?: readonly string[];
  config?: Readonly<Record<string, string | number | boolean>>;
}

export function buildOAuthAuthorizationUrl(input: BuildAuthorizationUrlInput): string {
  if (input.provider.authMode !== "oauth2_code" || !input.provider.auth.authorizationUrl) {
    throw new UnsupportedConnectorAuthModeError("Provider does not support OAuth authorization");
  }
  const authorizationUrl = new URL(
    interpolate(input.provider.auth.authorizationUrl, {
      clientId: input.clientId,
      ...(input.config ? { config: input.config } : {}),
    }),
  );
  for (const [name, value] of Object.entries(input.provider.auth.authorizationParams ?? {})) {
    authorizationUrl.searchParams.set(name, value);
  }
  authorizationUrl.searchParams.set("client_id", input.clientId);
  authorizationUrl.searchParams.set("redirect_uri", connectorCallbackUrl(input.authBaseUrl));
  authorizationUrl.searchParams.set("response_type", "code");
  const scopes =
    input.scopes && input.scopes.length > 0 ? input.scopes : input.provider.auth.defaultScopes;
  authorizationUrl.searchParams.set(
    "scope",
    scopes.join(input.provider.auth.scopeSeparator ?? " "),
  );
  authorizationUrl.searchParams.set("state", input.state);
  if (input.provider.auth.pkce) {
    const challenge = createHash("sha256").update(input.codeVerifier, "utf8").digest("base64url");
    authorizationUrl.searchParams.set("code_challenge", challenge);
    authorizationUrl.searchParams.set("code_challenge_method", "S256");
  }
  return authorizationUrl.toString();
}

export async function startOAuthConnect(db: Database, input: StartOAuthConnectInput) {
  const catalog = input.catalog ?? defaultCatalog;
  const provider = providerFrom(catalog, input.providerKey);
  if (provider.authMode === "mcp_oauth") {
    return startMcpOAuthConnect(db, provider, input);
  }
  if (provider.authMode !== "oauth2_code" || !provider.auth.authorizationUrl) {
    throw new UnsupportedConnectorAuthModeError(
      `Provider '${provider.key}' does not support the authorization-code connect flow`,
    );
  }

  const existing = input.reconnectConnectionId
    ? await db.connectorConnection.findFirst({
        where: {
          id: input.reconnectConnectionId,
          orgId: input.orgId,
          providerKey: input.providerKey,
          principalId: input.principalId,
        },
        select: { id: true, config: true },
      })
    : undefined;
  if (input.reconnectConnectionId && !existing) throw new ConnectorConnectionNotFoundError();
  const config = validateConfigFields(provider.configFields, {
    ...(existing ? declaredConfig(provider, existing.config) : {}),
    ...(input.config ?? {}),
  });
  const requestedScopes = requestedOAuthScopes(provider, {
    providerScopes: input.providerScopes,
  });
  validateProviderScopes(provider, requestedScopes);
  const registration = await resolveClientRegistration(
    db,
    input.orgId,
    input.providerKey,
    input.platformApps ?? emptyPlatformAppDirectory,
    input.masterKey,
  );

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const authorizationUrl = buildOAuthAuthorizationUrl({
    provider,
    clientId: registration.clientId,
    authBaseUrl: input.authBaseUrl,
    state,
    codeVerifier,
    scopes: requestedScopes,
    ...(Object.keys(config).length > 0 ? { config } : {}),
  });

  const now = input.now ?? new Date();
  await db.connectorOAuthState.create({
    data: {
      orgId: input.orgId,
      providerKey: input.providerKey,
      registrationId: registration.registrationId,
      ...(existing ? { connectionId: existing.id } : {}),
      principalId: input.principalId,
      stateHash: hashOAuthState(state),
      codeVerifier,
      config: config as Prisma.InputJsonValue,
      ...(input.label !== undefined ? { label: input.label } : {}),
      providerScopes: requestedScopes,
      ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    },
  });
  log.debug("OAuth state minted", {
    provider: input.providerKey,
    ...(existing ? { connectionId: existing.id } : {}),
  });

  return { authorizationUrl };
}

// The mcp_oauth connect flow (MCP authorization spec, June 2025 revision):
// discover the authorization server from the MCP server URL, resolve or
// dynamically register a client, then build a PKCE + resource authorization
// redirect. The discovered token endpoint and resource are persisted on the
// state so the callback can finish the exchange without re-running discovery.
async function startMcpOAuthConnect(
  db: Database,
  provider: ProviderDef,
  input: StartOAuthConnectInput,
) {
  if (provider.transport.type !== "mcp") {
    throw new UnsupportedConnectorAuthModeError(
      `Provider '${provider.key}' declares mcp_oauth without an MCP transport`,
    );
  }
  const existing = input.reconnectConnectionId
    ? await db.connectorConnection.findFirst({
        where: {
          id: input.reconnectConnectionId,
          orgId: input.orgId,
          providerKey: input.providerKey,
          principalId: input.principalId,
        },
        select: { id: true, config: true },
      })
    : undefined;
  if (input.reconnectConnectionId && !existing) throw new ConnectorConnectionNotFoundError();
  const config = validateConfigFields(provider.configFields, {
    ...(existing ? declaredConfig(provider, existing.config) : {}),
    ...(input.config ?? {}),
  });

  const serverUrl = provider.transport.serverUrl;
  const callbackUrl = connectorCallbackUrl(input.authBaseUrl);
  const platformApps = input.platformApps ?? emptyPlatformAppDirectory;
  const discovery = await discoverMcpAuthServer(serverUrl, input.fetch);
  const client = await resolveMcpClientRegistration(db, {
    orgId: input.orgId,
    providerKey: input.providerKey,
    discovery,
    callbackUrl,
    platformApps,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.fetch ? { fetch: input.fetch } : {}),
  });

  const state = randomBytes(32).toString("base64url");
  const { authorizationUrl, codeVerifier } = await buildMcpAuthorizationRequest({
    discovery,
    client,
    callbackUrl,
    serverUrl,
    state,
  });

  const now = input.now ?? new Date();
  await db.connectorOAuthState.create({
    data: {
      orgId: input.orgId,
      providerKey: input.providerKey,
      registrationId: client.registrationId,
      ...(existing ? { connectionId: existing.id } : {}),
      principalId: input.principalId,
      stateHash: hashOAuthState(state),
      codeVerifier,
      config: config as Prisma.InputJsonValue,
      ...(input.label !== undefined ? { label: input.label } : {}),
      providerScopes: discovery.requestedScopes,
      tokenEndpoint: discovery.tokenEndpoint,
      resource: serverUrl,
      ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    },
  });
  log.debug("OAuth state minted", {
    provider: input.providerKey,
    ...(existing ? { connectionId: existing.id } : {}),
  });

  return { authorizationUrl };
}

export async function consumeOAuthState(
  db: Database,
  state: string,
  now = new Date(),
): Promise<ConnectorOAuthState> {
  const stateHash = hashOAuthState(state);
  const rows = await db.$queryRaw<ConnectorOAuthState[]>`
    DELETE FROM "ConnectorOAuthState"
    WHERE "stateHash" = ${stateHash}
    RETURNING *
  `;
  const consumed = rows[0];
  if (!consumed) {
    log.warn("OAuth state reused or invalid");
    throw new OAuthStateSingleUseError();
  }
  if (consumed.expiresAt <= now) {
    log.warn("OAuth state expired", { provider: consumed.providerKey });
    throw new OAuthStateExpiredError();
  }
  log.debug("OAuth state consumed", { provider: consumed.providerKey });
  return consumed;
}

function recordFromJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OAuthTokenExchangeError();
  }
  return value as Record<string, unknown>;
}

function tokenResponseValue(response: Readonly<Record<string, unknown>>, path: string): unknown {
  let value: unknown = response;
  for (const segment of path.split(".")) {
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      return undefined;
    }
    value = (value as Record<string, unknown>)[segment];
  }
  return value;
}

export function extractTokenResponseMetadata(
  provider: ProviderDef,
  response: Readonly<Record<string, unknown>>,
): Record<string, unknown> {
  const fields = new Set([
    ...(provider.auth.tokenResponseMetadata ?? []),
    ...(provider.auth.accountIdentityFields ?? []),
  ]);
  return Object.fromEntries(
    [...fields].flatMap((field) => {
      const value = tokenResponseValue(response, field);
      return value === undefined ? [] : [[field, value]];
    }),
  );
}

async function connectionMetadata(
  provider: ProviderDef,
  tokenResponse: Readonly<Record<string, unknown>>,
  config: Readonly<Record<string, unknown>>,
): Promise<Record<string, unknown>> {
  const metadata = extractTokenResponseMetadata(provider, tokenResponse);
  const hookName = provider.hooks?.postConnection;
  if (!hookName) return metadata;

  const hook = providerHookRegistry[hookName];
  if (!hook) {
    // Catalog loading rejects this, but retain a safe guard for an injected
    // catalog and never expose the token response in an error.
    throw new ConnectorCatalogDefectError(
      `Provider '${provider.key}' has an unknown post-connection hook`,
    );
  }

  try {
    return { ...metadata, ...(await hook({ tokenResponse, config })) };
  } catch {
    // Hooks receive raw token responses; do not propagate any error detail,
    // including to the log, since a hook error may embed the raw response.
    log.warn("Connector post-connection hook failed", { provider: provider.key });
    throw new OAuthTokenExchangeError();
  }
}

function publicConnectionSelect() {
  return {
    id: true,
    providerKey: true,
    principalId: true,
    mode: true,
    providerScopes: true,
    label: true,
    expiresAt: true,
    revokedAt: true,
    lastRefreshSuccess: true,
    lastRefreshFailure: true,
    refreshAttempts: true,
    refreshExhausted: true,
    createdAt: true,
    updatedAt: true,
  } as const;
}

// A fresh connect may replace an already-connected provider account only when
// the provider explicitly declares stable identity fields and the response
// supplies every one. Arbitrary token metadata is never account identity.
async function sameAccountConnectionId(
  db: Database,
  input: { orgId: string; providerKey: string; principalId: string },
  metadata: Record<string, unknown> | undefined,
  identityFields: readonly string[] | undefined,
): Promise<string | undefined> {
  if (
    !metadata ||
    !identityFields ||
    identityFields.length === 0 ||
    !identityFields.every(
      (field) =>
        Object.hasOwn(metadata, field) && metadata[field] !== null && metadata[field] !== undefined,
    )
  ) {
    return undefined;
  }
  const candidates = await db.connectorConnection.findMany({
    where: {
      orgId: input.orgId,
      providerKey: input.providerKey,
      principalId: input.principalId,
      revokedAt: null,
    },
    select: { id: true, config: true },
    orderBy: [{ createdAt: "desc" }, { id: "desc" }],
  });
  const match = candidates.find((candidate) => {
    const stored = connectionConfig(candidate.config);
    return identityFields.every(
      (field) => JSON.stringify(stored[field]) === JSON.stringify(metadata[field]),
    );
  });
  return match?.id;
}

async function storeConnection(
  db: Database,
  input: {
    orgId: string;
    providerKey: string;
    principalId: string;
    mode: string;
    config: Record<string, unknown>;
    ciphertext: string;
    connectionId?: string;
    label?: string;
    expiresAt?: Date;
    providerScopes?: string[];
    metadata?: Record<string, unknown>;
    accountIdentityFields?: readonly string[];
  },
) {
  const config = JSON.parse(
    JSON.stringify({ ...input.config, ...(input.metadata ?? {}) }),
  ) as Prisma.InputJsonValue;
  const connectionId =
    input.connectionId ??
    (await sameAccountConnectionId(db, input, input.metadata, input.accountIdentityFields));
  if (connectionId) {
    const updated = await db.connectorConnection.updateMany({
      where: {
        id: connectionId,
        orgId: input.orgId,
        providerKey: input.providerKey,
        principalId: input.principalId,
      },
      data: {
        mode: input.mode,
        config,
        ciphertext: input.ciphertext,
        ...(input.label !== undefined ? { label: input.label } : {}),
        providerScopes: input.providerScopes ?? [],
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        lastRefreshSuccess: null,
        lastRefreshFailure: null,
        refreshFailureStartedAt: null,
        refreshAttempts: 0,
        refreshExhausted: false,
      },
    });
    if (updated.count === 0) throw new ConnectorConnectionNotFoundError();
    log.info("Connector connection updated", { connectionId, provider: input.providerKey });
    return db.connectorConnection.findUniqueOrThrow({
      where: { id: connectionId },
      select: publicConnectionSelect(),
    });
  }
  const created = await db.connectorConnection.create({
    data: {
      orgId: input.orgId,
      providerKey: input.providerKey,
      principalId: input.principalId,
      mode: input.mode,
      config,
      ciphertext: input.ciphertext,
      ...(input.label !== undefined ? { label: input.label } : {}),
      providerScopes: input.providerScopes ?? [],
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
    },
    select: publicConnectionSelect(),
  });
  log.info("Connector connection created", {
    connectionId: created.id,
    provider: input.providerKey,
  });
  return created;
}

export interface CompleteOAuthCallbackInput {
  state: string;
  code: string;
  authBaseUrl: string;
  masterKey?: string;
  catalog?: ProviderCatalog;
  platformApps?: PlatformAppDirectory;
  fetch?: ConnectorFetch;
  now?: Date;
}

export async function completeOAuthCallback(db: Database, input: CompleteOAuthCallbackInput) {
  const now = input.now ?? new Date();
  const oauthState = await consumeOAuthState(db, input.state, now);
  const provider = providerFrom(input.catalog ?? defaultCatalog, oauthState.providerKey);
  if (provider.authMode === "mcp_oauth") {
    return completeMcpOAuthCallback(db, provider, oauthState, input, now);
  }
  if (provider.authMode !== "oauth2_code" || !provider.auth.tokenUrl) {
    throw new UnsupportedConnectorAuthModeError("OAuth callback provider is not supported");
  }
  const registration = await resolveStoredClientRegistration(
    db,
    oauthState.orgId,
    oauthState.registrationId,
    input.platformApps ?? emptyPlatformAppDirectory,
    input.masterKey,
  );
  const tokenUrl = interpolate(provider.auth.tokenUrl, {
    clientId: registration.clientId,
    config: interpolationConfig(oauthState.config),
  });
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: input.code,
    redirect_uri: connectorCallbackUrl(input.authBaseUrl),
  });
  if (provider.auth.pkce) body.set("code_verifier", oauthState.codeVerifier);

  const headers = new Headers({
    Accept: "application/json",
    "Content-Type": "application/x-www-form-urlencoded",
  });
  if (provider.auth.tokenRequestAuthMethod === "body") {
    body.set("client_id", registration.clientId);
    body.set("client_secret", registration.clientSecret);
  } else if (provider.auth.tokenRequestAuthMethod === "private_key_jwt") {
    throw new UnsupportedConnectorAuthModeError("private_key_jwt arrives in a later connect flow");
  } else {
    headers.set(
      "Authorization",
      `Basic ${Buffer.from(`${registration.clientId}:${registration.clientSecret}`, "utf8").toString("base64")}`,
    );
  }

  let response: Response;
  try {
    response = await (input.fetch ?? globalThis.fetch)(tokenUrl, { method: "POST", headers, body });
  } catch (error) {
    log.warn("OAuth token exchange failed", { provider: provider.key, error });
    throw new OAuthTokenExchangeError();
  }
  if (!response.ok) {
    log.warn("OAuth token exchange failed", { provider: provider.key, status: response.status });
    throw new OAuthTokenExchangeError();
  }

  let raw: Record<string, unknown>;
  try {
    raw = recordFromJson(await response.json());
  } catch (error) {
    // A parse failure quotes the body it choked on, and that body is a token
    // response — the reason is all that can safely be logged.
    log.warn("OAuth token exchange failed", {
      provider: provider.key,
      reason: "malformed_token_response",
    });
    if (error instanceof OAuthTokenExchangeError) throw error;
    throw new OAuthTokenExchangeError();
  }
  const accessToken = raw.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    log.warn("OAuth token exchange failed", {
      provider: provider.key,
      reason: "missing_access_token",
    });
    throw new OAuthTokenExchangeError();
  }
  const refreshToken = typeof raw.refresh_token === "string" ? raw.refresh_token : undefined;
  const expiresIn =
    typeof raw.expires_in === "number"
      ? raw.expires_in
      : typeof raw.expires_in === "string"
        ? Number(raw.expires_in)
        : undefined;
  const expiresAt =
    expiresIn !== undefined && Number.isFinite(expiresIn) && expiresIn >= 0
      ? new Date(now.getTime() + expiresIn * 1000)
      : refreshToken
        ? new Date(now.getTime() + CONSERVATIVE_OAUTH_TOKEN_LIFETIME_MS)
        : undefined;
  const metadata = await connectionMetadata(provider, raw, connectionConfig(oauthState.config));
  const grantedScopes = parseGrantedScopes(
    raw.scope,
    oauthState.providerScopes,
    provider.auth.scopeSeparator,
  );
  const payload = { accessToken, ...(refreshToken ? { refreshToken } : {}), raw };
  const connection = await storeConnection(db, {
    orgId: oauthState.orgId,
    providerKey: oauthState.providerKey,
    principalId: oauthState.principalId,
    mode: provider.authMode,
    config: connectionConfig(oauthState.config),
    ciphertext: encryptEnvelope(payload, input.masterKey),
    ...(oauthState.connectionId ? { connectionId: oauthState.connectionId } : {}),
    ...(oauthState.label ? { label: oauthState.label } : {}),
    providerScopes: grantedScopes,
    ...(expiresAt ? { expiresAt } : {}),
    metadata,
    ...(provider.auth.accountIdentityFields
      ? { accountIdentityFields: provider.auth.accountIdentityFields }
      : {}),
  });
  return { connection, orgId: oauthState.orgId, returnTo: oauthState.returnTo };
}

// Complete an mcp_oauth callback: resolve the client identity recorded on the
// state, exchange the code at the persisted token endpoint (PKCE + RFC 8707
// resource), and store the credential in the same envelope shape as
// oauth2_code so sync's bearer resolution reads it unchanged.
async function completeMcpOAuthCallback(
  db: Database,
  provider: ProviderDef,
  oauthState: ConnectorOAuthState,
  input: CompleteOAuthCallbackInput,
  now: Date,
) {
  if (!oauthState.tokenEndpoint || !oauthState.resource) {
    // A well-formed mcp_oauth state always persists these; their absence means
    // the state was not produced by startMcpOAuthConnect.
    log.warn("OAuth token exchange failed", {
      provider: provider.key,
      reason: "invalid_state",
    });
    throw new OAuthTokenExchangeError();
  }
  const client = await resolveStoredMcpClientRegistration(db, {
    orgId: oauthState.orgId,
    registrationId: oauthState.registrationId,
    platformApps: input.platformApps ?? emptyPlatformAppDirectory,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
  });

  let tokens: Awaited<ReturnType<typeof exchangeMcpAuthorizationCode>>;
  try {
    tokens = await exchangeMcpAuthorizationCode({
      tokenEndpoint: oauthState.tokenEndpoint,
      resource: oauthState.resource,
      client,
      code: input.code,
      codeVerifier: oauthState.codeVerifier,
      callbackUrl: connectorCallbackUrl(input.authBaseUrl),
      ...(input.fetch ? { fetch: input.fetch } : {}),
    });
  } catch (error) {
    log.warn("OAuth token exchange failed", { provider: provider.key, error });
    throw new OAuthTokenExchangeError(error);
  }

  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    log.warn("OAuth token exchange failed", {
      provider: provider.key,
      reason: "missing_access_token",
    });
    throw new OAuthTokenExchangeError();
  }
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
  const expiresAt =
    typeof tokens.expires_in === "number" &&
    Number.isFinite(tokens.expires_in) &&
    tokens.expires_in >= 0
      ? new Date(now.getTime() + tokens.expires_in * 1000)
      : refreshToken
        ? new Date(now.getTime() + CONSERVATIVE_OAUTH_TOKEN_LIFETIME_MS)
        : undefined;
  const grantedScopes = parseGrantedScopes(
    tokens.scope,
    oauthState.providerScopes,
    provider.auth.scopeSeparator,
  );
  const payload = {
    accessToken,
    ...(refreshToken ? { refreshToken } : {}),
    raw: tokens as Record<string, unknown>,
  };
  const metadata = await connectionMetadata(
    provider,
    tokens as Record<string, unknown>,
    connectionConfig(oauthState.config),
  );
  const connection = await storeConnection(db, {
    orgId: oauthState.orgId,
    providerKey: oauthState.providerKey,
    principalId: oauthState.principalId,
    mode: provider.authMode,
    config: connectionConfig(oauthState.config),
    ciphertext: encryptEnvelope(payload, input.masterKey),
    ...(oauthState.connectionId ? { connectionId: oauthState.connectionId } : {}),
    ...(oauthState.label ? { label: oauthState.label } : {}),
    providerScopes: grantedScopes,
    ...(expiresAt ? { expiresAt } : {}),
    metadata,
    ...(provider.auth.accountIdentityFields
      ? { accountIdentityFields: provider.auth.accountIdentityFields }
      : {}),
  });
  return { connection, orgId: oauthState.orgId, returnTo: oauthState.returnTo };
}

function validateField(
  name: string,
  descriptor: FieldDescriptor,
  value: unknown,
  fieldKind: "Config" | "Credential",
): string | undefined {
  if (value === undefined || value === "") {
    if (descriptor.optional) return descriptor.default;
    throw new StaticCredentialValidationError(`${fieldKind} field '${name}' is required`);
  }
  if (typeof value !== "string") {
    throw new StaticCredentialValidationError(`${fieldKind} field '${name}' must be a string`);
  }
  if (descriptor.enum && !descriptor.enum.includes(value)) {
    throw new StaticCredentialValidationError(
      `${fieldKind} field '${name}' is not an allowed value`,
    );
  }
  if (descriptor.pattern && !new RegExp(descriptor.pattern).test(value)) {
    throw new StaticCredentialValidationError(`${fieldKind} field '${name}' has an invalid format`);
  }
  return value;
}

function validateFields(
  descriptors: Readonly<Record<string, FieldDescriptor>>,
  submitted: Readonly<Record<string, unknown>>,
  fieldKind: "Config" | "Credential",
): Record<string, string> {
  const unknown = Object.keys(submitted).find((name) => !Object.hasOwn(descriptors, name));
  if (unknown)
    throw new StaticCredentialValidationError(
      `Unknown ${fieldKind.toLowerCase()} field '${unknown}'`,
    );
  return Object.fromEntries(
    Object.entries(descriptors).flatMap(([name, descriptor]) => {
      const value = validateField(name, descriptor, submitted[name], fieldKind);
      return value === undefined ? [] : [[name, value]];
    }),
  );
}

function validateCredentialFields(
  descriptors: Readonly<Record<string, FieldDescriptor>>,
  submitted: Readonly<Record<string, unknown>>,
) {
  return validateFields(descriptors, submitted, "Credential");
}

function validateConfigFields(
  descriptors: Readonly<Record<string, FieldDescriptor>>,
  submitted: Readonly<Record<string, unknown>>,
) {
  return validateFields(descriptors, submitted, "Config");
}

function validateProviderScopes(provider: ProviderDef, requested: readonly string[]) {
  if (provider.authMode !== "oauth2_code" || !provider.auth.availableScopes) return;
  const available = new Set(provider.auth.availableScopes);
  const unknown = requested.find((scope) => !available.has(scope));
  if (unknown) {
    throw new StaticCredentialValidationError(
      `OAuth scope '${unknown}' is not available from provider '${provider.key}'`,
    );
  }
  if (new Set(requested).size !== requested.length) {
    throw new StaticCredentialValidationError("OAuth scopes cannot contain duplicates");
  }
}

function basicAuthorization(credentials: Readonly<Record<string, string>>): string {
  const username = credentials.username ?? credentials.user;
  const password = credentials.password ?? credentials.pass;
  if (username === undefined || password === undefined) {
    throw new ConnectorCatalogDefectError(
      "Basic connector credentials must declare username/password or user/pass fields",
    );
  }
  return `Basic ${Buffer.from(`${username}:${password}`, "utf8").toString("base64")}`;
}

export interface CreateStaticConnectionInput {
  orgId: string;
  principalId: string;
  providerKey: string;
  credentials: Readonly<Record<string, unknown>>;
  config: Readonly<Record<string, string | number | boolean>>;
  label?: string;
  reconnectConnectionId?: string;
  masterKey?: string;
  catalog?: ProviderCatalog;
  fetch?: ConnectorFetch;
}

export async function createStaticConnection(db: Database, input: CreateStaticConnectionInput) {
  const provider = providerFrom(input.catalog ?? defaultCatalog, input.providerKey);
  if (provider.authMode !== "api_key" && provider.authMode !== "basic") {
    throw new UnsupportedConnectorAuthModeError(
      `Provider '${provider.key}' does not support static credential entry`,
    );
  }
  if (provider.transport.type !== "rest" || !provider.transport.verification) {
    throw new ConnectorCatalogDefectError(
      `Provider '${provider.key}' has no static credential verification recipe`,
    );
  }
  const existing = input.reconnectConnectionId
    ? await db.connectorConnection.findFirst({
        where: {
          id: input.reconnectConnectionId,
          orgId: input.orgId,
          providerKey: input.providerKey,
          principalId: input.principalId,
        },
        select: { id: true, config: true },
      })
    : undefined;
  if (input.reconnectConnectionId && !existing) throw new ConnectorConnectionNotFoundError();
  const credentials = validateCredentialFields(provider.credentialFields, input.credentials);
  const config = validateConfigFields(provider.configFields, {
    ...(existing ? declaredConfig(provider, existing.config) : {}),
    ...input.config,
  });
  const baseUrl = interpolate(provider.transport.baseUrl, {
    ...(Object.keys(config).length > 0 ? { config } : {}),
    credentials,
  });
  const headers = new Headers({ Accept: "application/json" });
  if (provider.authMode === "basic") {
    headers.set("Authorization", basicAuthorization(credentials));
  } else if (provider.transport.authHeader) {
    headers.set(
      "Authorization",
      interpolate(provider.transport.authHeader, {
        ...(Object.keys(config).length > 0 ? { config } : {}),
        credentials,
      }),
    );
  } else if (provider.transport.authHeaders) {
    for (const [header, value] of Object.entries(provider.transport.authHeaders)) {
      headers.set(
        header,
        interpolate(value, {
          ...(Object.keys(config).length > 0 ? { config } : {}),
          credentials,
        }),
      );
    }
  } else {
    throw new ConnectorCatalogDefectError(
      `Provider '${provider.key}' has no API-key authentication header template`,
    );
  }

  let verified = false;
  for (const endpoint of provider.transport.verification.endpoints) {
    const url = new URL(
      interpolate(endpoint, {
        ...(Object.keys(config).length > 0 ? { config } : {}),
        credentials,
      }),
      baseUrl,
    ).toString();
    const verificationBody = provider.transport.verification.body;
    if (verificationBody) headers.set("Content-Type", "application/json");
    try {
      const response = await (input.fetch ?? globalThis.fetch)(url, {
        method: provider.transport.verification.method,
        headers,
        ...(verificationBody ? { body: JSON.stringify(verificationBody) } : {}),
      });
      if (response.ok) {
        verified = true;
        break;
      }
    } catch {
      // Try any remaining verification endpoints before rejecting creation.
    }
  }
  if (!verified) {
    log.warn("Connector credential verification failed", { provider: provider.key });
    throw new CredentialVerificationError();
  }

  const payload = { ...credentials, raw: { ...credentials } };
  return storeConnection(db, {
    orgId: input.orgId,
    providerKey: input.providerKey,
    principalId: input.principalId,
    mode: provider.authMode,
    config,
    ciphertext: encryptEnvelope(payload, input.masterKey),
    ...(input.label !== undefined ? { label: input.label } : {}),
    ...(existing ? { connectionId: existing.id } : {}),
  });
}

export async function updateConnectorConnectionLabel(
  db: Database,
  input: { orgId: string; connectionId: string; label: string | null; principalId?: string },
) {
  const updated = await db.connectorConnection.updateMany({
    where: {
      id: input.connectionId,
      orgId: input.orgId,
      ...(input.principalId ? { principalId: input.principalId } : {}),
    },
    data: { label: input.label },
  });
  if (updated.count === 0) throw new ConnectorConnectionNotFoundError();
  log.info("Connector connection label updated", { connectionId: input.connectionId });
  return db.connectorConnection.findUniqueOrThrow({
    where: { id: input.connectionId },
    select: publicConnectionSelect(),
  });
}

// Derive a display label from the provider's hoisted token-response metadata
// (an account or workspace name) when the connection has no explicit label.
// Config itself never leaves the server; only the derived string does.
function metadataLabel(
  catalog: ProviderCatalog,
  providerKey: string,
  config: Prisma.JsonValue,
): string | undefined {
  const provider = catalog.find(({ key }) => key === providerKey);
  const stored = connectionConfig(config);
  for (const key of provider?.auth.tokenResponseMetadata ?? []) {
    const value = stored[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

export async function listConnectorConnections(
  db: Database,
  orgId: string,
  providerKey?: string,
  now = new Date(),
  principalId?: string,
  catalog: ProviderCatalog = defaultCatalog,
) {
  const [connections, installations] = await Promise.all([
    db.connectorConnection.findMany({
      where: {
        orgId,
        ...(providerKey ? { providerKey } : {}),
        ...(principalId ? { principalId } : {}),
      },
      select: { ...publicConnectionSelect(), config: true },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
    }),
    // No principal filter here: bindings only surface when their connectionId
    // matches a listed connection, and binding validation already ties a
    // connection's principal to the scopes it may serve.
    db.item.findMany({
      where: { orgId, kind: "connector", status: { not: "archived" } },
      select: { id: true, scopeId: true, body: true },
    }),
  ]);
  const bindings = new Map<string, Array<{ id: string; scopeId: string }>>();
  for (const installation of installations) {
    if (
      typeof installation.body !== "object" ||
      installation.body === null ||
      Array.isArray(installation.body)
    ) {
      continue;
    }
    const connectionId = installation.body.connectionId;
    if (typeof connectionId !== "string") continue;
    const current = bindings.get(connectionId) ?? [];
    current.push({ id: installation.id, scopeId: installation.scopeId });
    bindings.set(connectionId, current);
  }
  return connections.map(({ config, ...connection }) => ({
    ...connection,
    label: connection.label ?? metadataLabel(catalog, connection.providerKey, config) ?? null,
    installations: bindings.get(connection.id) ?? [],
    ...connectorConnectionValidity(connection, now),
  }));
}

export function connectorConnectionValidity(
  connection: { revokedAt: Date | null; expiresAt: Date | null; refreshExhausted: boolean },
  now = new Date(),
) {
  const isRevoked = connection.revokedAt !== null;
  const isExpired = connection.expiresAt !== null && connection.expiresAt <= now;
  return {
    isRevoked,
    isExpired,
    isValid: !isRevoked && !isExpired && !connection.refreshExhausted,
  };
}

export async function revokeConnectorConnection(
  db: Database,
  orgId: string,
  connectionId: string,
  principalId?: string,
) {
  const revokedAt = new Date();
  const result = await db.connectorConnection.updateMany({
    where: { id: connectionId, orgId, ...(principalId ? { principalId } : {}) },
    data: { revokedAt },
  });
  if (result.count === 0) throw new ConnectorConnectionNotFoundError();
  log.info("Connector connection revoked", { connectionId });
  return { id: connectionId, revokedAt };
}
