import { createHash } from "node:crypto";
import {
  figmaProvider,
  githubProvider,
  loadProviderCatalog,
  TemplateInterpolationError,
} from "@trema/connectors";
import { describe, expect, it, vi } from "vitest";
import {
  buildOAuthAuthorizationUrl,
  extractTokenResponseMetadata,
  parseGrantedScopes,
  requestedOAuthScopes,
} from "#server/services/connectors/connect.js";
import {
  buildMcpAuthorizationRequest,
  discoverMcpAuthServer,
  exchangeMcpAuthorizationCode,
  type McpAuthServer,
  McpOAuthDiscoveryError,
  type ResolvedMcpClient,
} from "#server/services/connectors/mcp-oauth.js";

const baseProvider = {
  ...githubProvider,
  auth: { ...githubProvider.auth, pkce: true },
};

describe("token response metadata", () => {
  it("extracts explicit nested account identity paths without hoisting their siblings", () => {
    const provider = loadProviderCatalog([
      {
        ...baseProvider,
        auth: {
          ...baseProvider.auth,
          tokenResponseMetadata: ["display_name"],
          accountIdentityFields: ["account.id"],
        },
      },
    ])[0]!;

    expect(
      extractTokenResponseMetadata(provider, {
        display_name: "Example",
        account: { id: "acct-123", mutable_name: "Renamed later" },
      }),
    ).toEqual({
      display_name: "Example",
      "account.id": "acct-123",
    });
  });
});

describe("OAuth authorization URL construction", () => {
  it("uses the deployment callback, scopes, state, and an S256 PKCE challenge", () => {
    const provider = loadProviderCatalog([baseProvider])[0]!;
    const codeVerifier = "fixed-verifier";
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example/base",
        state: "opaque-state",
        codeVerifier,
      }),
    );

    expect(result.searchParams.get("client_id")).toBe("client-id");
    expect(result.searchParams.get("redirect_uri")).toBe(
      "https://auth.trema.example/connect/callback",
    );
    expect(result.searchParams.get("scope")).toBe("read:user repo");
    expect(result.searchParams.get("state")).toBe("opaque-state");
    expect(result.searchParams.get("code_challenge_method")).toBe("S256");
    expect(result.searchParams.get("code_challenge")).toBe(
      createHash("sha256").update(codeVerifier).digest("base64url"),
    );
  });

  it("requests the supplied scopes over the provider defaults", () => {
    const provider = loadProviderCatalog([githubProvider])[0]!;
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "verifier",
        scopes: ["repo", "workflow", "read:org"],
      }),
    );

    expect(result.searchParams.get("scope")).toBe("repo workflow read:org");
  });

  it("joins supplied scopes with the provider's scope separator", () => {
    const provider = loadProviderCatalog([figmaProvider])[0]!;
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "verifier",
        scopes: ["files:read", "projects:read"],
      }),
    );

    expect(result.searchParams.get("scope")).toBe("files:read,projects:read");
  });

  it("falls back to the provider defaults when no scopes are supplied", () => {
    const provider = loadProviderCatalog([githubProvider])[0]!;
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "verifier",
        scopes: [],
      }),
    );

    expect(result.searchParams.get("scope")).toBe("read:user repo");
  });

  it("omits PKCE parameters for providers that explicitly opt out", () => {
    const provider = loadProviderCatalog([githubProvider])[0]!;
    const result = new URL(
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "unused-verifier",
      }),
    );

    expect(result.searchParams.has("code_challenge")).toBe(false);
    expect(result.searchParams.has("code_challenge_method")).toBe(false);
  });

  it("rejects an unfilled URL placeholder before returning a redirect", () => {
    const provider = loadProviderCatalog([
      {
        ...baseProvider,
        configFields: {
          tenant: { type: "string", title: "Tenant", description: "Provider tenant" },
        },
        auth: {
          ...baseProvider.auth,
          authorizationUrl: `https://\${config.tenant}.example.test/oauth/authorize`,
        },
      },
    ])[0]!;

    expect(() =>
      buildOAuthAuthorizationUrl({
        provider,
        clientId: "client-id",
        authBaseUrl: "https://auth.trema.example",
        state: "opaque-state",
        codeVerifier: "verifier",
      }),
    ).toThrow(TemplateInterpolationError);
  });
});

describe("requestedOAuthScopes", () => {
  const provider = loadProviderCatalog([githubProvider])[0]!;

  it("prefers a non-empty installation override over the provider defaults", () => {
    expect(requestedOAuthScopes(provider, { providerScopes: ["repo", "workflow"] })).toEqual([
      "repo",
      "workflow",
    ]);
  });

  it("uses the provider defaults when the override is absent or empty", () => {
    expect(requestedOAuthScopes(provider, {})).toEqual(["read:user", "repo"]);
    expect(requestedOAuthScopes(provider, { providerScopes: [] })).toEqual(["read:user", "repo"]);
    expect(requestedOAuthScopes(provider, null)).toEqual(["read:user", "repo"]);
  });
});

describe("parseGrantedScopes", () => {
  const requested = ["read:user", "repo"];

  it("splits a comma-separated GitHub-style granted scope string", () => {
    expect(parseGrantedScopes("repo,read:org,gist", requested)).toEqual([
      "repo",
      "read:org",
      "gist",
    ]);
  });

  it("splits a space-separated granted scope string", () => {
    expect(parseGrantedScopes("repo read:org gist", requested)).toEqual([
      "repo",
      "read:org",
      "gist",
    ]);
  });

  it("honors the provider's scope separator while tolerating stray whitespace", () => {
    expect(parseGrantedScopes("files:read, projects:read", requested, ",")).toEqual([
      "files:read",
      "projects:read",
    ]);
  });

  it("falls back to the requested scopes when the response omits scope", () => {
    expect(parseGrantedScopes(undefined, requested)).toEqual(requested);
    expect(parseGrantedScopes("", requested)).toEqual(requested);
    expect(parseGrantedScopes("   ", requested)).toEqual(requested);
  });
});

const MCP_SERVER_URL = "https://mcp.example.test/mcp";
const AS_ORIGIN = "https://auth.example.test";
const CALLBACK_URL = "https://auth.trema.example/connect/callback";

function jsonResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function authServerMetadata(overrides: Record<string, unknown> = {}) {
  return {
    issuer: `${AS_ORIGIN}/`,
    authorization_endpoint: `${AS_ORIGIN}/authorize`,
    token_endpoint: `${AS_ORIGIN}/token`,
    registration_endpoint: `${AS_ORIGIN}/register`,
    response_types_supported: ["code"],
    code_challenge_methods_supported: ["S256"],
    ...overrides,
  };
}

interface DiscoveryStub {
  protectedResource?: Record<string, unknown> | null;
  authServer?: Record<string, unknown> | null;
  wwwAuthenticate?: string;
}

// Routes the SDK's discovery probes by URL substring so a single stub answers
// the WWW-Authenticate probe, RFC 9728 protected-resource lookup, and RFC 8414
// authorization-server lookup.
function discoveryFetch(stub: DiscoveryStub) {
  return vi.fn(async (input: string | URL | Request, _init?: RequestInit) => {
    const url =
      typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
    if (url.includes("oauth-protected-resource")) {
      return stub.protectedResource
        ? jsonResponse(stub.protectedResource)
        : new Response(null, { status: 404 });
    }
    if (url.includes("oauth-authorization-server") || url.includes("openid-configuration")) {
      return stub.authServer ? jsonResponse(stub.authServer) : new Response(null, { status: 404 });
    }
    // Unauthenticated probe of the MCP server itself.
    return new Response(null, {
      status: 401,
      headers: stub.wwwAuthenticate ? { "WWW-Authenticate": stub.wwwAuthenticate } : {},
    });
  }) as unknown as typeof globalThis.fetch;
}

describe("discoverMcpAuthServer", () => {
  it("resolves the authorization server from RFC 9728 protected-resource metadata", async () => {
    const fetchStub = discoveryFetch({
      protectedResource: {
        resource: MCP_SERVER_URL,
        authorization_servers: [`${AS_ORIGIN}/`],
        scopes_supported: ["read", "write"],
      },
      authServer: authServerMetadata(),
    });

    const discovered = await discoverMcpAuthServer(MCP_SERVER_URL, fetchStub);

    expect(discovered.authorizationServerUrl).toBe(`${AS_ORIGIN}/`);
    expect(discovered.authorizationEndpoint).toBe(`${AS_ORIGIN}/authorize`);
    expect(discovered.tokenEndpoint).toBe(`${AS_ORIGIN}/token`);
    expect(discovered.registrationEndpoint).toBe(`${AS_ORIGIN}/register`);
    expect(discovered.requestedScopes).toEqual(["read", "write"]);
  });

  it("honors a WWW-Authenticate resource_metadata hint from the server", async () => {
    const hintedUrl = `${MCP_SERVER_URL}/.well-known/oauth-protected-resource/hinted`;
    const fetchStub = discoveryFetch({
      wwwAuthenticate: `Bearer resource_metadata="${hintedUrl}"`,
      protectedResource: {
        resource: MCP_SERVER_URL,
        authorization_servers: [`${AS_ORIGIN}/`],
      },
      authServer: authServerMetadata(),
    });

    await discoverMcpAuthServer(MCP_SERVER_URL, fetchStub);

    const requestedUrls = (fetchStub as unknown as ReturnType<typeof vi.fn>).mock.calls.map(
      (call) => String(call[0]),
    );
    expect(requestedUrls).toContain(hintedUrl);
  });

  it("falls back to the MCP server origin when protected-resource metadata is absent", async () => {
    const fetchStub = discoveryFetch({
      protectedResource: null,
      authServer: authServerMetadata(),
    });

    const discovered = await discoverMcpAuthServer(MCP_SERVER_URL, fetchStub);

    // No RFC 9728 metadata: the MCP server origin acts as the authorization server.
    expect(discovered.authorizationServerUrl).toBe("https://mcp.example.test/");
    expect(discovered.requestedScopes).toEqual([]);
  });

  it("rejects a non-https authorization endpoint", async () => {
    const fetchStub = discoveryFetch({
      protectedResource: {
        resource: MCP_SERVER_URL,
        authorization_servers: [`${AS_ORIGIN}/`],
      },
      authServer: authServerMetadata({
        authorization_endpoint: "http://auth.example.test/authorize",
      }),
    });

    await expect(discoverMcpAuthServer(MCP_SERVER_URL, fetchStub)).rejects.toBeInstanceOf(
      McpOAuthDiscoveryError,
    );
  });

  it("rejects a non-https MCP server URL before probing", async () => {
    const fetchStub = discoveryFetch({});
    await expect(
      discoverMcpAuthServer("http://mcp.example.test/mcp", fetchStub),
    ).rejects.toBeInstanceOf(McpOAuthDiscoveryError);
    expect(fetchStub).not.toHaveBeenCalled();
  });
});

const publicClient: ResolvedMcpClient = {
  registrationId: "reg-1",
  source: "dynamic",
  clientId: "dynamic-client",
};

function discoveryFixture(scopes: string[]): McpAuthServer {
  return {
    authorizationServerUrl: `${AS_ORIGIN}/`,
    authorizationEndpoint: `${AS_ORIGIN}/authorize`,
    tokenEndpoint: `${AS_ORIGIN}/token`,
    registrationEndpoint: `${AS_ORIGIN}/register`,
    metadata: authServerMetadata() as NonNullable<McpAuthServer["metadata"]>,
    requestedScopes: scopes,
  };
}

describe("buildMcpAuthorizationRequest", () => {
  it("builds a PKCE + resource redirect and omits scope when none is advertised", async () => {
    const { authorizationUrl, codeVerifier } = await buildMcpAuthorizationRequest({
      discovery: discoveryFixture([]),
      client: publicClient,
      callbackUrl: CALLBACK_URL,
      serverUrl: MCP_SERVER_URL,
      state: "opaque-state",
    });

    const url = new URL(authorizationUrl);
    expect(`${url.origin}${url.pathname}`).toBe(`${AS_ORIGIN}/authorize`);
    expect(url.searchParams.get("client_id")).toBe("dynamic-client");
    expect(url.searchParams.get("redirect_uri")).toBe(CALLBACK_URL);
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("resource")).toBe(MCP_SERVER_URL);
    expect(url.searchParams.get("state")).toBe("opaque-state");
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.has("code_challenge")).toBe(true);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(codeVerifier).toBeTruthy();
  });

  it("requests the advertised scopes when present", async () => {
    const { authorizationUrl } = await buildMcpAuthorizationRequest({
      discovery: discoveryFixture(["read", "write"]),
      client: publicClient,
      callbackUrl: CALLBACK_URL,
      serverUrl: MCP_SERVER_URL,
      state: "opaque-state",
    });

    expect(new URL(authorizationUrl).searchParams.get("scope")).toBe("read write");
  });
});

describe("exchangeMcpAuthorizationCode", () => {
  it("exchanges the code at the token endpoint with PKCE, resource, and a public client_id", async () => {
    const tokenFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      expect(String(input)).toBe(`${AS_ORIGIN}/token`);
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      const params = new URLSearchParams(String(init?.body));
      expect(params.get("grant_type")).toBe("authorization_code");
      expect(params.get("code")).toBe("auth-code");
      expect(params.get("code_verifier")).toBe("pkce-verifier");
      expect(params.get("resource")).toBe(MCP_SERVER_URL);
      expect(params.get("client_id")).toBe("dynamic-client");
      expect(params.has("client_secret")).toBe(false);
      return jsonResponse({
        access_token: "mcp-access-token",
        token_type: "bearer",
        scope: "read",
        expires_in: 3600,
        workspace_id: "workspace-123",
      });
    }) as unknown as typeof globalThis.fetch;

    const tokens = await exchangeMcpAuthorizationCode({
      tokenEndpoint: `${AS_ORIGIN}/token`,
      resource: MCP_SERVER_URL,
      client: publicClient,
      code: "auth-code",
      codeVerifier: "pkce-verifier",
      callbackUrl: CALLBACK_URL,
      fetch: tokenFetch,
    });

    expect(tokens.access_token).toBe("mcp-access-token");
    expect(tokens.scope).toBe("read");
    expect(tokens.workspace_id).toBe("workspace-123");
  });

  it("uses Basic auth when the registration carries a secret", async () => {
    const tokenFetch = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const auth = new Headers(init?.headers).get("Authorization");
      expect(auth).toBe(`Basic ${Buffer.from("confidential:s3cret").toString("base64")}`);
      const params = new URLSearchParams(String(init?.body));
      expect(params.has("client_secret")).toBe(false);
      return jsonResponse({ access_token: "token", token_type: "bearer" });
    }) as unknown as typeof globalThis.fetch;

    await exchangeMcpAuthorizationCode({
      tokenEndpoint: `${AS_ORIGIN}/token`,
      resource: MCP_SERVER_URL,
      client: {
        registrationId: "reg-2",
        source: "customer",
        clientId: "confidential",
        clientSecret: "s3cret",
      },
      code: "auth-code",
      codeVerifier: "pkce-verifier",
      callbackUrl: CALLBACK_URL,
      fetch: tokenFetch,
    });
  });
});
