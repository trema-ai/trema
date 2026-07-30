import type { ProviderDefInput } from "#connectors/schema.js";

// Vercel's official remote MCP server is beta and available only to approved
// clients, so the GA REST API is the production transport for this provider.
export const vercelProvider = {
  key: "vercel",
  trusted: true,
  displayName: "Vercel",
  description: "Inspect and manage Vercel users, teams, projects, deployments, and domains.",
  logoUrl: "/connector-logos/vercel.svg",
  categories: ["developer-tools"],
  docsUrl: "https://vercel.com/docs/rest-api",
  authMode: "api_key",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {
    apiKey: {
      type: "string",
      title: "Access token",
      description: "A Vercel access token with access to the required account or team.",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: "https://api.vercel.com",
    openApiSpecUrl: "https://openapi.vercel.sh",
    authHeader: `Bearer \${credentials.apiKey}`,
    verification: { method: "GET", endpoints: ["/v2/user"] },
  },
  toolManifest: [
    {
      name: "get_current_user",
      description: "Get the Vercel user associated with the access token.",
      method: "GET",
      path: "/v2/user",
      paramsSchema: { type: "object", properties: {} },
    },
    {
      name: "list_teams",
      description: "List teams accessible to the connected Vercel user.",
      method: "GET",
      path: "/v2/teams",
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          since: { type: "number" },
          until: { type: "number" },
        },
      },
    },
    {
      name: "list_projects",
      description: "List Vercel projects for the current account or selected team.",
      method: "GET",
      path: "/v10/projects",
      paramsSchema: {
        type: "object",
        properties: {
          search: { type: "string" },
          limit: { type: "string" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
      },
    },
    {
      name: "get_project",
      description: "Get a Vercel project by id or name.",
      method: "GET",
      path: "/v9/projects/{idOrName}",
      paramsSchema: {
        type: "object",
        properties: {
          idOrName: { type: "string" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
        required: ["idOrName"],
      },
    },
    {
      name: "list_deployments",
      description: "List deployments for the current account, team, or project.",
      method: "GET",
      path: "/v7/deployments",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          target: { type: "string" },
          state: { type: "string" },
          limit: { type: "integer" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
      },
    },
    {
      name: "get_deployment",
      description: "Get one deployment by id or URL.",
      method: "GET",
      path: "/v13/deployments/{idOrUrl}",
      paramsSchema: {
        type: "object",
        properties: {
          idOrUrl: { type: "string" },
          withGitRepoInfo: { type: "string" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
        required: ["idOrUrl"],
      },
    },
    {
      name: "create_deployment",
      description: "Create a Vercel deployment from a Git repository or source files.",
      method: "POST",
      path: "/v13/deployments",
      paramsSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          project: { type: "string" },
          gitSource: { type: "object" },
          files: { type: "array", items: { type: "object" } },
          target: { type: "string" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
      },
    },
    {
      name: "cancel_deployment",
      description: "Cancel an in-progress Vercel deployment.",
      method: "PATCH",
      path: "/v12/deployments/{id}/cancel",
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_domains",
      description: "List domains for the current Vercel account or selected team.",
      method: "GET",
      path: "/v5/domains",
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          since: { type: "number" },
          until: { type: "number" },
          teamId: { type: "string" },
          slug: { type: "string" },
        },
      },
    },
  ],
} satisfies ProviderDefInput;
