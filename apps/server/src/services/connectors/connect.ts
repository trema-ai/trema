import { createHash, randomBytes } from "node:crypto";

import type { ConnectorOAuthState, Prisma } from "#/generated/prisma/client.js";
import { encryptEnvelope } from "#/lib/crypto/index.js";
import type { Database } from "#/lib/db/index.js";
import { loadProviderCatalog, type ProviderCatalog } from "#/services/connectors/catalog.js";
import {
  ConnectorProviderNotFoundError,
  emptyPlatformAppDirectory,
  type PlatformAppDirectory,
  resolveClientRegistration,
  resolveStoredClientRegistration,
} from "#/services/connectors/registrations.js";
import type { FieldDescriptor, ProviderDef } from "#/services/connectors/schema.js";
import { interpolate } from "#/services/connectors/templates.js";

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

function callbackUrl(authBaseUrl: string): string {
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
  now?: Date;
}

export interface BuildAuthorizationUrlInput {
  provider: ProviderDef;
  clientId: string;
  authBaseUrl: string;
  state: string;
  codeVerifier: string;
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
  authorizationUrl.searchParams.set("client_id", input.clientId);
  authorizationUrl.searchParams.set("redirect_uri", callbackUrl(input.authBaseUrl));
  authorizationUrl.searchParams.set("response_type", "code");
  authorizationUrl.searchParams.set(
    "scope",
    input.provider.auth.defaultScopes.join(input.provider.auth.scopeSeparator ?? " "),
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
  const authorizationUrl = buildOAuthAuthorizationUrl({
    provider,
    clientId: registration.clientId,
    authBaseUrl: input.authBaseUrl,
    state,
    codeVerifier,
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
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}),
      },
      update: {
        mode: input.mode,
        ciphertext: input.ciphertext,
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
    redirect_uri: callbackUrl(input.authBaseUrl),
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
  const payload = { accessToken, ...(refreshToken ? { refreshToken } : {}), raw };
  const credential = await storeCredential(db, {
    orgId: oauthState.orgId,
    installationItemId: oauthState.installationItemId,
    principalId: oauthState.principalId,
    mode: provider.authMode,
    ciphertext: encryptEnvelope(payload, input.masterKey),
    ...(expiresAt ? { expiresAt } : {}),
    metadata,
  });
  return { credential, returnTo: oauthState.returnTo };
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
  return credentials.map((credential) => {
    const isRevoked = credential.revokedAt !== null;
    const isExpired = credential.expiresAt !== null && credential.expiresAt <= now;
    return {
      ...credential,
      isRevoked,
      isExpired,
      isValid: !isRevoked && !isExpired && !credential.refreshExhausted,
    };
  });
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
