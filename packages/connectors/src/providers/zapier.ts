import type { ProviderDefInput } from "#connectors/schema.js";

// Zapier MCP endpoints are user-created tool bundles with connection-specific
// URLs, so the stable OAuth REST API is the catalog's shared transport.
export const zapierProvider = {
  key: "zapier",
  displayName: "Zapier",
  description:
    "Inspect and manage Zaps, Zap runs, app actions, and authentications over the Zapier REST API.",
  logoUrl: "/connector-logos/zapier.svg",
  categories: ["productivity"],
  docsUrl: "https://docs.zapier.com/powered-by-zapier/api-reference/",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://api.zapier.com/v2/authorize",
    tokenUrl: "https://zapier.com/oauth/token",
    defaultScopes: ["profile", "zap:all", "zap:write", "zap:runs", "authentication"],
    // Full Zapier OAuth scope vocabulary (verbatim from Nango's scope catalog).
    availableScopes: [
      "action:run",
      "authentication",
      "authentication:write",
      "profile",
      "promotions:read",
      "promotions:write",
      "zap",
      "zap:all",
      "zap:runs",
      "zap:write",
    ],
    pkce: false,
    authorizationParams: { response_mode: "query" },
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.zapier.com",
    // Zapier's API reference is not shipped as a stable public OpenAPI 3 document.
    verification: { method: "GET", endpoints: ["/v2/profile"] },
  },
  toolManifest: [
    {
      name: "get_profile",
      description: "Get the profile for the connected Zapier user.",
      method: "GET",
      path: "/v2/profile",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
    {
      name: "list_zaps",
      description: "List Zaps available to the connected Zapier user.",
      method: "GET",
      path: "/v2/zaps",
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          offset: { type: "integer" },
          include_shared: { type: "boolean" },
          expand: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_zap",
      description: "Get a Zap by id.",
      method: "GET",
      path: "/v2/zaps/{id}",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" }, expand: { type: "string" } },
        required: ["id"],
      },
      sensitivity: "read",
    },
    {
      name: "create_zap",
      description: "Create a Zap from a title and configured steps.",
      method: "POST",
      path: "/v2/zaps",
      paramsSchema: {
        type: "object",
        properties: {
          data: {
            type: "object",
            properties: {
              title: { type: "string" },
              steps: { type: "array", items: { type: "object" } },
            },
            required: ["title", "steps"],
          },
        },
        required: ["data"],
      },
      sensitivity: "write",
    },
    {
      name: "update_zap",
      description: "Update a Zap's title, steps, or enabled state.",
      method: "PATCH",
      path: "/v2/zaps/{id}",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" }, data: { type: "object" } },
        required: ["id", "data"],
      },
      sensitivity: "write",
    },
    {
      name: "delete_zap",
      description: "Delete a Zap.",
      method: "DELETE",
      path: "/v2/zaps/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sensitivity: "destructive",
    },
    {
      name: "list_zap_runs",
      description: "List execution runs for a Zap.",
      method: "GET",
      path: "/v2/zap-runs",
      paramsSchema: {
        type: "object",
        properties: {
          zap_id: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "list_actions",
      description: "List available Zapier app actions.",
      method: "GET",
      path: "/v2/actions",
      paramsSchema: {
        type: "object",
        properties: {
          search: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "list_authentications",
      description: "List app authentications available to the connected Zapier user.",
      method: "GET",
      path: "/v2/authentications",
      paramsSchema: {
        type: "object",
        properties: { limit: { type: "integer" }, offset: { type: "integer" } },
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
