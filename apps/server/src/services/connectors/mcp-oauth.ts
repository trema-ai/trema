import {
  discoverOAuthServerInfo,
  exchangeAuthorization,
  extractResourceMetadataUrl,
  registerClient,
  startAuthorization,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  AuthorizationServerMetadata,
  OAuthClientInformationMixed,
  OAuthProtectedResourceMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";

import type { ClientRegistrationSource } from "#/generated/prisma/client.js";
import { decryptEnvelope, encryptEnvelope } from "#/lib/crypto/index.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import {
  ClientRegistrationNotFoundError,
  NoClientRegistrationError,
  type PlatformAppDirectory,
} from "#/services/connectors/registrations.js";

type FetchLike = typeof globalThis.fetch;

// The client identity Trema registers with an MCP authorization server. Most
// public dynamic clients receive no secret; when a customer or platform app is
// pre-registered the secret is carried so the token exchange can authenticate.
const TREMA_CLIENT_NAME = "Trema";

export class McpOAuthDiscoveryError extends Error {
  readonly code = "mcp_discovery_failed";

  constructor(message: string) {
    super(message);
    this.name = "McpOAuthDiscoveryError";
  }
}

export interface McpAuthServer {
  authorizationServerUrl: string;
  authorizationEndpoint: string;
  tokenEndpoint: string;
  registrationEndpoint?: string;
  metadata?: AuthorizationServerMetadata;
  resourceMetadata?: OAuthProtectedResourceMetadata;
  // The scopes to request: the protected-resource metadata's scopes_supported
  // when advertised, otherwise none (MCP servers grant a default scope set).
  requestedScopes: string[];
}

function assertHttps(url: string, label: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new McpOAuthDiscoveryError(`Discovered ${label} is not a valid URL`);
  }
  if (parsed.protocol !== "https:") {
    throw new McpOAuthDiscoveryError(`Discovered ${label} must use https`);
  }
}

// Best-effort probe of the MCP server for an RFC 9728 `WWW-Authenticate:
// Bearer resource_metadata="…"` hint. Guarded by a short timeout and a
// swallowed failure so a server that streams or hangs never blocks discovery;
// the RFC 9728 well-known lookup remains the primary path.
async function probeResourceMetadataUrl(
  serverUrl: string,
  fetchFn: FetchLike,
): Promise<URL | undefined> {
  try {
    const response = await fetchFn(serverUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: "trema-discovery", method: "initialize" }),
      signal: AbortSignal.timeout(5000),
    });
    const url = extractResourceMetadataUrl(response);
    await response.body?.cancel().catch(() => {});
    return url;
  } catch {
    return undefined;
  }
}

// Locate an MCP server's authorization server (RFC 9728 protected-resource
// metadata, then RFC 8414 / OIDC AS metadata) with the SDK's discovery
// helpers, falling back to treating the MCP server origin as the authorization
// server. Validates that the endpoints we will redirect and exchange against
// are https.
export async function discoverMcpAuthServer(
  serverUrl: string,
  fetchFn: FetchLike = globalThis.fetch,
): Promise<McpAuthServer> {
  assertHttps(serverUrl, "MCP server URL");
  const resourceMetadataUrl = await probeResourceMetadataUrl(serverUrl, fetchFn);

  let info: Awaited<ReturnType<typeof discoverOAuthServerInfo>>;
  try {
    info = await discoverOAuthServerInfo(serverUrl, {
      fetchFn,
      ...(resourceMetadataUrl ? { resourceMetadataUrl } : {}),
    });
  } catch (error) {
    log.warn("MCP OAuth discovery failed", { error });
    throw new McpOAuthDiscoveryError(
      `Could not discover the authorization server for ${serverUrl}: ${
        error instanceof Error ? error.message : "unknown error"
      }`,
    );
  }

  const metadata = info.authorizationServerMetadata;
  const authorizationEndpoint =
    metadata?.authorization_endpoint ??
    new URL("/authorize", info.authorizationServerUrl).toString();
  const tokenEndpoint =
    metadata?.token_endpoint ?? new URL("/token", info.authorizationServerUrl).toString();
  assertHttps(authorizationEndpoint, "authorization endpoint");
  assertHttps(tokenEndpoint, "token endpoint");

  const advertisedScopes = info.resourceMetadata?.scopes_supported ?? [];

  return {
    authorizationServerUrl: info.authorizationServerUrl,
    authorizationEndpoint,
    tokenEndpoint,
    ...(metadata?.registration_endpoint
      ? { registrationEndpoint: metadata.registration_endpoint }
      : {}),
    ...(metadata ? { metadata } : {}),
    ...(info.resourceMetadata ? { resourceMetadata: info.resourceMetadata } : {}),
    requestedScopes: advertisedScopes,
  };
}

export interface ResolvedMcpClient {
  registrationId: string;
  source: ClientRegistrationSource;
  clientId: string;
  clientSecret?: string;
  tokenEndpointAuthMethod?: string;
}

// A registration usable for the mcp_oauth flow. Unlike oauth2_code, public
// dynamic clients legitimately carry no secret, so a stored clientId alone is
// enough for customer and dynamic sources.
function usableStored(
  registration: {
    id: string;
    source: ClientRegistrationSource;
    clientId: string | null;
    clientSecretCiphertext: string | null;
    tokenEndpointAuthMethod: string | null;
  },
  masterKey: string | undefined,
): ResolvedMcpClient | undefined {
  if (!registration.clientId) return undefined;
  return {
    registrationId: registration.id,
    source: registration.source,
    clientId: registration.clientId,
    ...(registration.clientSecretCiphertext
      ? { clientSecret: decryptEnvelope<string>(registration.clientSecretCiphertext, masterKey) }
      : {}),
    ...(registration.tokenEndpointAuthMethod
      ? { tokenEndpointAuthMethod: registration.tokenEndpointAuthMethod }
      : {}),
  };
}

export interface ResolveMcpClientRegistrationInput {
  orgId: string;
  providerKey: string;
  discovery: McpAuthServer;
  callbackUrl: string;
  platformApps: PlatformAppDirectory;
  masterKey?: string;
  fetch?: FetchLike;
}

type McpClientRegistrationReadDatabase = Pick<Database, "clientRegistration">;

export interface ResolveExistingMcpClientRegistrationInput {
  orgId: string;
  providerKey: string;
  platformApps: PlatformAppDirectory;
  masterKey?: string;
}

// Refresh must reuse the client identity that was selected (and, for DCR,
// persisted) during connect. It deliberately never performs a new dynamic
// registration: losing the existing registration is a reconnect condition.
export async function resolveExistingMcpClientRegistration(
  db: McpClientRegistrationReadDatabase,
  input: ResolveExistingMcpClientRegistrationInput,
): Promise<ResolvedMcpClient | undefined> {
  const registrations = await db.clientRegistration.findMany({
    where: { orgId: input.orgId, providerKey: input.providerKey },
  });

  for (const source of ["customer", "dynamic"] as const) {
    const registration = registrations.find((candidate) => candidate.source === source);
    const resolved = registration && usableStored(registration, input.masterKey);
    if (resolved) return resolved;
  }

  const platform = registrations.find((candidate) => candidate.source === "platform");
  if (!platform?.sharedRef) return undefined;
  const app = await input.platformApps.get(platform.sharedRef);
  if (!app) return undefined;
  return {
    registrationId: platform.id,
    source: platform.source,
    clientId: app.clientId,
    clientSecret: app.clientSecret,
  };
}

// Resolve the client registration for an mcp_oauth connect: prefer a
// pre-registered customer app, then a previously persisted dynamic
// registration, then a platform app. When none exists and the authorization
// server advertises a registration endpoint, perform RFC 7591 dynamic client
// registration and persist it as a "dynamic" ClientRegistration for reuse.
export async function resolveMcpClientRegistration(
  db: Database,
  input: ResolveMcpClientRegistrationInput,
): Promise<ResolvedMcpClient> {
  const existing = await resolveExistingMcpClientRegistration(db, input);
  if (existing) return existing;

  if (!input.discovery.registrationEndpoint) {
    log.warn("MCP client registration unavailable", { provider: input.providerKey });
    throw new NoClientRegistrationError(input.providerKey);
  }

  let registered: Awaited<ReturnType<typeof registerClient>>;
  try {
    registered = await registerClient(input.discovery.authorizationServerUrl, {
      ...(input.discovery.metadata ? { metadata: input.discovery.metadata } : {}),
      clientMetadata: {
        client_name: TREMA_CLIENT_NAME,
        redirect_uris: [input.callbackUrl],
        grant_types: ["authorization_code", "refresh_token"],
        response_types: ["code"],
        token_endpoint_auth_method: "none",
      },
      ...(input.fetch ? { fetchFn: input.fetch } : {}),
    });
  } catch (error) {
    log.warn("MCP dynamic client registration failed", { provider: input.providerKey, error });
    throw error;
  }

  const row = await db.clientRegistration.create({
    data: {
      orgId: input.orgId,
      providerKey: input.providerKey,
      source: "dynamic",
      clientId: registered.client_id,
      clientSecretCiphertext: registered.client_secret
        ? encryptEnvelope(registered.client_secret, input.masterKey)
        : null,
      tokenEndpointAuthMethod: registered.token_endpoint_auth_method ?? null,
      notes: "Dynamically registered via RFC 7591",
    },
    select: { id: true },
  });

  return {
    registrationId: row.id,
    source: "dynamic",
    clientId: registered.client_id,
    ...(registered.client_secret ? { clientSecret: registered.client_secret } : {}),
    ...(registered.token_endpoint_auth_method
      ? { tokenEndpointAuthMethod: registered.token_endpoint_auth_method }
      : {}),
  };
}

// Resolve the client identity recorded on an mcp_oauth state at callback time.
// Mirrors resolveMcpClientRegistration's tolerance for secret-less public
// clients.
export async function resolveStoredMcpClientRegistration(
  db: Database,
  input: {
    orgId: string;
    registrationId: string;
    platformApps: PlatformAppDirectory;
    masterKey?: string;
  },
): Promise<ResolvedMcpClient> {
  const registration = await db.clientRegistration.findFirst({
    where: { id: input.registrationId, orgId: input.orgId },
  });
  if (!registration) {
    log.warn("MCP client registration not found");
    throw new ClientRegistrationNotFoundError();
  }

  if (registration.source === "platform") {
    const app = registration.sharedRef
      ? await input.platformApps.get(registration.sharedRef)
      : undefined;
    if (!app) {
      log.warn("MCP client registration unavailable", { provider: registration.providerKey });
      throw new NoClientRegistrationError(registration.providerKey);
    }
    return {
      registrationId: registration.id,
      source: registration.source,
      clientId: app.clientId,
      clientSecret: app.clientSecret,
    };
  }

  const resolved = usableStored(registration, input.masterKey);
  if (!resolved) {
    log.warn("MCP client registration unavailable", { provider: registration.providerKey });
    throw new NoClientRegistrationError(registration.providerKey);
  }
  return resolved;
}

function clientInformation(client: ResolvedMcpClient): OAuthClientInformationMixed {
  // Preserve the method selected by RFC 7591. Inferring Basic merely from the
  // presence of a secret breaks servers that issued client_secret_post
  // registrations. Public clients still pin "none" so client_id is sent.
  return {
    client_id: client.clientId,
    ...(client.clientSecret ? { client_secret: client.clientSecret } : {}),
    ...(client.tokenEndpointAuthMethod
      ? { token_endpoint_auth_method: client.tokenEndpointAuthMethod }
      : !client.clientSecret
        ? { token_endpoint_auth_method: "none" }
        : {}),
  };
}

// Build the authorization redirect (PKCE S256, RFC 8707 resource, state) via
// the SDK. Returns the URL to send the browser to plus the PKCE verifier to
// persist alongside our single-use state.
export async function buildMcpAuthorizationRequest(input: {
  discovery: McpAuthServer;
  client: ResolvedMcpClient;
  callbackUrl: string;
  serverUrl: string;
  state: string;
}): Promise<{ authorizationUrl: string; codeVerifier: string }> {
  const scope = input.discovery.requestedScopes.join(" ");
  const { authorizationUrl, codeVerifier } = await startAuthorization(
    input.discovery.authorizationServerUrl,
    {
      ...(input.discovery.metadata ? { metadata: input.discovery.metadata } : {}),
      clientInformation: { client_id: input.client.clientId },
      redirectUrl: input.callbackUrl,
      ...(scope ? { scope } : {}),
      state: input.state,
      resource: new URL(input.serverUrl),
    },
  );
  return { authorizationUrl: authorizationUrl.toString(), codeVerifier };
}

// Exchange the authorization code at the persisted token endpoint (PKCE +
// RFC 8707 resource, "none" auth for public clients). The SDK sends the
// client_id in the body for public clients and Basic auth when a secret is
// present.
export async function exchangeMcpAuthorizationCode(input: {
  tokenEndpoint: string;
  resource: string;
  client: ResolvedMcpClient;
  code: string;
  codeVerifier: string;
  callbackUrl: string;
  fetch?: FetchLike;
}): Promise<OAuthTokens & Record<string, unknown>> {
  let rawTokens: Record<string, unknown> = {};
  const fetchFn: FetchLike = async (...args) => {
    const response = await (input.fetch ?? globalThis.fetch)(...args);
    if (response.ok) {
      try {
        const raw: unknown = await response.clone().json();
        if (typeof raw === "object" && raw !== null && !Array.isArray(raw)) {
          rawTokens = raw as Record<string, unknown>;
        }
      } catch {
        // The SDK reports malformed successful responses consistently.
      }
    }
    return response;
  };
  const tokens = await exchangeAuthorization(input.tokenEndpoint, {
    // Only token_endpoint is read from metadata here; the endpoint was
    // validated as https during discovery.
    metadata: { token_endpoint: input.tokenEndpoint } as AuthorizationServerMetadata,
    clientInformation: clientInformation(input.client),
    authorizationCode: input.code,
    codeVerifier: input.codeVerifier,
    redirectUri: input.callbackUrl,
    resource: new URL(input.resource),
    fetchFn,
  });
  // The SDK validates and strips provider extensions. Preserve those extensions
  // for explicit account identity fields while letting validated OAuth values
  // win over their raw representations.
  return { ...rawTokens, ...tokens };
}
