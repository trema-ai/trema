import { createHash, randomBytes } from "node:crypto";
import type { FieldDescriptor, ProviderDef } from "@trema/connectors";
import { interpolate, loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import type { ConnectorOAuthState, Prisma } from "#/generated/prisma/client.js";
import { encryptEnvelope } from "#/lib/crypto/index.js";
import type { Database } from "#/lib/db/index.js";
import {
  buildMcpAuthorizationRequest,
  discoverMcpAuthServer,
  exchangeMcpAuthorizationCode,
  resolveMcpClientRegistration,
  resolveStoredMcpClientRegistration,
} from "#/services/connectors/mcp-oauth.js";
import {
  ConnectorProviderNotFoundError,
  emptyPlatformAppDirectory,
  type PlatformAppDirectory,
  resolveClientRegistration,
  resolveStoredClientRegistration,
} from "#/services/connectors/registrations.js";

const defaultCatalog = loadProviderCatalog();
const OAUTH_STATE_TTL_MS = 15 * 60 * 1000;

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

  constructor() {
    super("OAuth token exchange failed");
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

export class ConnectorCredentialNotFoundError extends Error {
  constructor() {
    super("Connector credential not found");
    this.name = "ConnectorCredentialNotFoundError";
  }
}

function providerFrom(catalog: ProviderCatalog, providerKey: string): ProviderDef {
  const provider = catalog.find(({ key }) => key === providerKey);
  if (!provider) throw new ConnectorProviderNotFoundError(providerKey);
  return provider;
}

function installationCatalogKey(body: Prisma.JsonValue): string | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  const value = body.catalogKey;
  return typeof value === "string" ? value : undefined;
}

function installationConfig(
  body: Prisma.JsonValue,
): Readonly<Record<string, string | number | boolean>> {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return {};
  const config = body.config;
  if (typeof config !== "object" || config === null || Array.isArray(config)) return {};
  return Object.fromEntries(
    Object.entries(config).filter(
      (entry): entry is [string, string | number | boolean] =>
        typeof entry[1] === "string" ||
        typeof entry[1] === "number" ||
        typeof entry[1] === "boolean",
    ),
  );
}

function installationProviderScopes(body: Prisma.JsonValue): string[] {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return [];
  const scopes = body.providerScopes;
  if (!Array.isArray(scopes)) return [];
  return scopes.filter((scope): scope is string => typeof scope === "string" && scope.length > 0);
}

// The scopes an authorization request will ask for: the installation override
// when present and non-empty, otherwise the provider's defaults.
export function requestedOAuthScopes(provider: ProviderDef, body: Prisma.JsonValue): string[] {
  const override = installationProviderScopes(body);
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

async function assertInstallation(
  db: Database,
  orgId: string,
  installationItemId: string,
  providerKey: string,
) {
  const installation = await db.item.findFirst({
    where: { id: installationItemId, orgId },
  });
  if (installation?.kind !== "connector") {
    throw new ConnectorInstallationError("Connector installation not found");
  }
  if (installationCatalogKey(installation.body) !== providerKey) {
    throw new ConnectorInstallationError("Connector installation provider does not match");
  }
  return installation;
}

async function assertPrincipal(db: Database, orgId: string, principalId: string) {
  const principal = await db.principal.findFirst({ where: { id: principalId, orgId } });
  if (!principal) throw new ConnectorInstallationError("Credential principal not found");
}

export function hashOAuthState(state: string): string {
  return createHash("sha256").update(state, "utf8").digest("hex");
}

export function connectorCallbackUrl(authBaseUrl: string): string {
  return new URL("/connect/callback", authBaseUrl).toString();
}

export interface StartOAuthConnectInput {
  orgId: string;
  providerKey: string;
  installationItemId: string;
  principalId: string;
  authBaseUrl: string;
  masterKey?: string;
  returnTo?: string;
  config?: Readonly<Record<string, string | number | boolean>>;
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

  const [installation] = await Promise.all([
    assertInstallation(db, input.orgId, input.installationItemId, input.providerKey),
    assertPrincipal(db, input.orgId, input.principalId),
  ]);
  const registration = await resolveClientRegistration(
    db,
    input.orgId,
    input.providerKey,
    input.platformApps ?? emptyPlatformAppDirectory,
    input.masterKey,
  );

  const state = randomBytes(32).toString("base64url");
  const codeVerifier = randomBytes(32).toString("base64url");
  const config = { ...installationConfig(installation.body), ...input.config };
  const requestedScopes = requestedOAuthScopes(provider, installation.body);
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
      installationItemId: input.installationItemId,
      principalId: input.principalId,
      stateHash: hashOAuthState(state),
      codeVerifier,
      // Persist the requested scopes so the callback can record them when the
      // token response omits its own `scope` field.
      providerScopes: requestedScopes,
      ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    },
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
  // Validate the installation and principal exist; mcp_oauth needs no config
  // interpolation, so the installation body itself is not read here.
  await Promise.all([
    assertInstallation(db, input.orgId, input.installationItemId, input.providerKey),
    assertPrincipal(db, input.orgId, input.principalId),
  ]);

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
      installationItemId: input.installationItemId,
      principalId: input.principalId,
      stateHash: hashOAuthState(state),
      codeVerifier,
      // Record the scopes we asked for so the callback can attribute them when
      // the token response omits its own `scope`.
      providerScopes: discovery.requestedScopes,
      tokenEndpoint: discovery.tokenEndpoint,
      resource: serverUrl,
      ...(input.returnTo !== undefined ? { returnTo: input.returnTo } : {}),
      expiresAt: new Date(now.getTime() + OAUTH_STATE_TTL_MS),
    },
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
  if (!consumed) throw new OAuthStateSingleUseError();
  if (consumed.expiresAt <= now) throw new OAuthStateExpiredError();
  return consumed;
}

function recordFromJson(value: unknown): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new OAuthTokenExchangeError();
  }
  return value as Record<string, unknown>;
}

function publicCredentialSelect() {
  return {
    id: true,
    installationItemId: true,
    principalId: true,
    mode: true,
    providerScopes: true,
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

async function storeCredential(
  db: Database,
  input: {
    orgId: string;
    installationItemId: string;
    principalId: string;
    mode: string;
    ciphertext: string;
    expiresAt?: Date;
    providerScopes?: string[];
    metadata?: Record<string, unknown>;
  },
) {
  return db.$transaction(async (transaction) => {
    if (input.metadata && Object.keys(input.metadata).length > 0) {
      const installation = await transaction.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: input.orgId, id: input.installationItemId } },
        select: { body: true },
      });
      const body =
        typeof installation.body === "object" &&
        installation.body !== null &&
        !Array.isArray(installation.body)
          ? installation.body
          : {};
      const existingConfig =
        typeof body.config === "object" && body.config !== null && !Array.isArray(body.config)
          ? body.config
          : {};
      await transaction.item.update({
        where: { orgId_id: { orgId: input.orgId, id: input.installationItemId } },
        data: {
          body: JSON.parse(
            JSON.stringify({ ...body, config: { ...existingConfig, ...input.metadata } }),
          ) as Prisma.InputJsonValue,
        },
      });
    }

    return transaction.connectorCredential.upsert({
      where: {
        installationItemId_principalId: {
          installationItemId: input.installationItemId,
          principalId: input.principalId,
        },
      },
      create: {
        orgId: input.orgId,
        installationItemId: input.installationItemId,
        principalId: input.principalId,
        mode: input.mode,
        ciphertext: input.ciphertext,
        providerScopes: input.providerScopes ?? [],
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
      update: {
        mode: input.mode,
        ciphertext: input.ciphertext,
        providerScopes: input.providerScopes ?? [],
        expiresAt: input.expiresAt ?? null,
        revokedAt: null,
        lastRefreshSuccess: null,
        lastRefreshFailure: null,
        refreshAttempts: 0,
        refreshExhausted: false,
      },
      select: publicCredentialSelect(),
    });
  });
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
  const installation = await assertInstallation(
    db,
    oauthState.orgId,
    oauthState.installationItemId,
    oauthState.providerKey,
  );
  const tokenUrl = interpolate(provider.auth.tokenUrl, {
    clientId: registration.clientId,
    config: installationConfig(installation.body),
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
  } catch {
    throw new OAuthTokenExchangeError();
  }
  if (!response.ok) throw new OAuthTokenExchangeError();

  let raw: Record<string, unknown>;
  try {
    raw = recordFromJson(await response.json());
  } catch (error) {
    if (error instanceof OAuthTokenExchangeError) throw error;
    throw new OAuthTokenExchangeError();
  }
  const accessToken = raw.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
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
      : undefined;
  const metadata = Object.fromEntries(
    (provider.auth.tokenResponseMetadata ?? [])
      .filter((field) => raw[field] !== undefined)
      .map((field) => [field, raw[field]]),
  );
  const grantedScopes = parseGrantedScopes(
    raw.scope,
    oauthState.providerScopes,
    provider.auth.scopeSeparator,
  );
  const payload = { accessToken, ...(refreshToken ? { refreshToken } : {}), raw };
  const credential = await storeCredential(db, {
    orgId: oauthState.orgId,
    installationItemId: oauthState.installationItemId,
    principalId: oauthState.principalId,
    mode: provider.authMode,
    ciphertext: encryptEnvelope(payload, input.masterKey),
    providerScopes: grantedScopes,
    ...(expiresAt ? { expiresAt } : {}),
    metadata,
  });
  return { credential, orgId: oauthState.orgId, returnTo: oauthState.returnTo };
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
  } catch {
    throw new OAuthTokenExchangeError();
  }

  const accessToken = tokens.access_token;
  if (typeof accessToken !== "string" || accessToken.length === 0) {
    throw new OAuthTokenExchangeError();
  }
  const refreshToken = typeof tokens.refresh_token === "string" ? tokens.refresh_token : undefined;
  const expiresAt =
    typeof tokens.expires_in === "number" &&
    Number.isFinite(tokens.expires_in) &&
    tokens.expires_in >= 0
      ? new Date(now.getTime() + tokens.expires_in * 1000)
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
  const credential = await storeCredential(db, {
    orgId: oauthState.orgId,
    installationItemId: oauthState.installationItemId,
    principalId: oauthState.principalId,
    mode: provider.authMode,
    ciphertext: encryptEnvelope(payload, input.masterKey),
    providerScopes: grantedScopes,
    ...(expiresAt ? { expiresAt } : {}),
  });
  return { credential, orgId: oauthState.orgId, returnTo: oauthState.returnTo };
}

function validateField(
  name: string,
  descriptor: FieldDescriptor,
  value: unknown,
): string | undefined {
  if (value === undefined || value === "") {
    if (descriptor.optional) return descriptor.default;
    throw new StaticCredentialValidationError(`Credential field '${name}' is required`);
  }
  if (typeof value !== "string") {
    throw new StaticCredentialValidationError(`Credential field '${name}' must be a string`);
  }
  if (descriptor.enum && !descriptor.enum.includes(value)) {
    throw new StaticCredentialValidationError(`Credential field '${name}' is not an allowed value`);
  }
  if (descriptor.pattern && !new RegExp(descriptor.pattern).test(value)) {
    throw new StaticCredentialValidationError(`Credential field '${name}' has an invalid format`);
  }
  return value;
}

function validateCredentialFields(
  descriptors: Readonly<Record<string, FieldDescriptor>>,
  submitted: Readonly<Record<string, unknown>>,
): Record<string, string> {
  const unknown = Object.keys(submitted).find((name) => !Object.hasOwn(descriptors, name));
  if (unknown) throw new StaticCredentialValidationError(`Unknown credential field '${unknown}'`);
  return Object.fromEntries(
    Object.entries(descriptors).flatMap(([name, descriptor]) => {
      const value = validateField(name, descriptor, submitted[name]);
      return value === undefined ? [] : [[name, value]];
    }),
  );
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

export interface CreateStaticCredentialInput {
  orgId: string;
  providerKey: string;
  installationItemId: string;
  principalId: string;
  credentials: Readonly<Record<string, unknown>>;
  config?: Readonly<Record<string, string | number | boolean>>;
  masterKey?: string;
  catalog?: ProviderCatalog;
  fetch?: ConnectorFetch;
}

export async function createStaticCredential(db: Database, input: CreateStaticCredentialInput) {
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
  const [installation] = await Promise.all([
    assertInstallation(db, input.orgId, input.installationItemId, input.providerKey),
    assertPrincipal(db, input.orgId, input.principalId),
  ]);
  const credentials = validateCredentialFields(provider.credentialFields, input.credentials);
  const config = { ...installationConfig(installation.body), ...input.config };
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
  } else {
    throw new ConnectorCatalogDefectError(
      `Provider '${provider.key}' has no API-key authHeader template`,
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
  if (!verified) throw new CredentialVerificationError();

  const payload = { ...credentials, raw: { ...credentials } };
  return storeCredential(db, {
    orgId: input.orgId,
    installationItemId: input.installationItemId,
    principalId: input.principalId,
    mode: provider.authMode,
    ciphertext: encryptEnvelope(payload, input.masterKey),
  });
}

export async function listConnectorCredentials(
  db: Database,
  orgId: string,
  installationItemId: string,
  now = new Date(),
) {
  const credentials = await db.connectorCredential.findMany({
    where: { orgId, installationItemId },
    select: publicCredentialSelect(),
    orderBy: [{ createdAt: "asc" }, { id: "asc" }],
  });
  return credentials.map((credential) => ({
    ...credential,
    ...connectorCredentialValidity(credential, now),
  }));
}

export function connectorCredentialValidity(
  credential: { revokedAt: Date | null; expiresAt: Date | null; refreshExhausted: boolean },
  now = new Date(),
) {
  const isRevoked = credential.revokedAt !== null;
  const isExpired = credential.expiresAt !== null && credential.expiresAt <= now;
  return {
    isRevoked,
    isExpired,
    isValid: !isRevoked && !isExpired && !credential.refreshExhausted,
  };
}

export async function revokeConnectorCredential(
  db: Database,
  orgId: string,
  installationItemId: string,
  credentialId: string,
) {
  const revokedAt = new Date();
  const result = await db.connectorCredential.updateMany({
    where: { id: credentialId, orgId, installationItemId },
    data: { revokedAt },
  });
  if (result.count === 0) throw new ConnectorCredentialNotFoundError();
  return { id: credentialId, revokedAt };
}
