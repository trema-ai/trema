import type { ProviderDefInput } from "#connectors/schema.js";

export const linearProvider = {
  key: "linear",
  trusted: true,
  displayName: "Linear",
  description:
    "Access issues, projects, and comments in Linear workspaces. Tools come from Linear's official MCP server.",
  logoUrl: "/connector-logos/linear.svg",
  categories: ["project-management"],
  docsUrl: "https://linear.app/docs/mcp",
  authMode: "mcp_oauth",
  oauthActor: "user",
  auth: {
    defaultScopes: [],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "mcp",
    serverUrl: "https://mcp.linear.app/mcp",
  },
} satisfies ProviderDefInput;
