import type { ProviderDefInput } from "#/schema.js";

// n8n's official MCP server serves product documentation, not an n8n instance's
// workflows or executions, so this provider uses the instance REST API.
export const n8nProvider = {
  key: "n8n",
  displayName: "n8n",
  description:
    "Manage n8n workflows, executions, tags, variables, and projects through its REST API.",
  logoUrl: "/connector-logos/n8n.svg",
  categories: ["developer-tools"],
  docsUrl: "https://docs.n8n.io/api/api-reference/",
  authMode: "api_key",
  auth: { defaultScopes: [] },
  configFields: {
    baseUrl: {
      type: "string",
      title: "Instance URL",
      description: "The base URL of the n8n instance.",
      example: "https://your-instance.app.n8n.cloud",
      pattern: "^https?://[^\\s]+[^/\\s]$",
    },
  },
  credentialFields: {
    apiKey: {
      type: "string",
      title: "API key",
      description: "An n8n API key with access to the required resources.",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: `\${config.baseUrl}/api/v1`,
    authHeader: `X-N8N-API-KEY: \${credentials.apiKey}`,
    // n8n serves API documentation from each instance rather than a stable public OpenAPI 3 URL.
    verification: { method: "GET", endpoints: ["/workflows?limit=1"] },
  },
  toolManifest: [
    {
      name: "list_workflows",
      description: "List workflows in the n8n instance.",
      method: "GET",
      path: "/workflows",
      paramsSchema: {
        type: "object",
        properties: {
          active: { type: "boolean" },
          tags: { type: "string" },
          projectId: { type: "string" },
          limit: { type: "integer" },
          cursor: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_workflow",
      description: "Get an n8n workflow by id.",
      method: "GET",
      path: "/workflows/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sensitivity: "read",
    },
    {
      name: "create_workflow",
      description: "Create an n8n workflow.",
      method: "POST",
      path: "/workflows",
      paramsSchema: {
        type: "object",
        properties: {
          name: { type: "string" },
          nodes: { type: "array", items: { type: "object" } },
          connections: { type: "object" },
          settings: { type: "object" },
        },
        required: ["name", "nodes", "connections"],
      },
      sensitivity: "write",
    },
    {
      name: "update_workflow",
      description: "Update an existing n8n workflow.",
      method: "PUT",
      path: "/workflows/{id}",
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          name: { type: "string" },
          nodes: { type: "array", items: { type: "object" } },
          connections: { type: "object" },
          settings: { type: "object" },
        },
        required: ["id", "name", "nodes", "connections"],
      },
      sensitivity: "write",
    },
    {
      name: "delete_workflow",
      description: "Delete an n8n workflow.",
      method: "DELETE",
      path: "/workflows/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sensitivity: "destructive",
    },
    {
      name: "list_executions",
      description: "List n8n workflow executions.",
      method: "GET",
      path: "/executions",
      paramsSchema: {
        type: "object",
        properties: {
          workflowId: { type: "string" },
          status: { type: "string" },
          includeData: { type: "boolean" },
          limit: { type: "integer" },
          cursor: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_execution",
      description: "Get an n8n execution by id.",
      method: "GET",
      path: "/executions/{id}",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" }, includeData: { type: "boolean" } },
        required: ["id"],
      },
      sensitivity: "read",
    },
    {
      name: "list_tags",
      description: "List tags in the n8n instance.",
      method: "GET",
      path: "/tags",
      paramsSchema: {
        type: "object",
        properties: { limit: { type: "integer" }, cursor: { type: "string" } },
      },
      sensitivity: "read",
    },
    {
      name: "create_tag",
      description: "Create a tag in the n8n instance.",
      method: "POST",
      path: "/tags",
      paramsSchema: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
      sensitivity: "write",
    },
  ],
  memberConnectable: false,
} satisfies ProviderDefInput;
