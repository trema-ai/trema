import type { ProviderDefInput } from "#/services/connectors/schema.js";

export const linearProvider = {
  key: "linear",
  displayName: "Linear",
  categories: ["project-management"],
  docsUrl: "https://linear.app/developers/graphql",
  authMode: "api_key",
  auth: {
    defaultScopes: [],
  },
  configFields: {},
  credentialFields: {
    apiKey: {
      type: "string",
      title: "API key",
      description: "A Linear personal API key.",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: "https://api.linear.app",
    authHeader: `\${credentials.apiKey}`,
    verification: {
      method: "POST",
      endpoints: ["/graphql"],
      body: { query: "{ viewer { id } }" },
    },
  },
  toolManifest: [
    {
      name: "search_issues",
      description: "Search Linear issues using a GraphQL query.",
      method: "POST",
      path: "/graphql",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          variables: { type: "object" },
        },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "create_comment",
      description: "Create a comment on a Linear issue using a GraphQL mutation.",
      method: "POST",
      path: "/graphql",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          variables: { type: "object" },
        },
        required: ["query", "variables"],
      },
      sensitivity: "write",
    },
  ],
  memberConnectable: false,
} satisfies ProviderDefInput;
