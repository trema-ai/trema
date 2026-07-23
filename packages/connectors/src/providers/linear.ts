import type { ProviderDefInput } from "#/schema.js";

export const linearProvider = {
  key: "linear",
  displayName: "Linear",
  description:
    "Access issues, projects, and comments in Linear workspaces. Tools come from Linear's official MCP server.",
  logoUrl: "/connector-logos/linear.svg",
  categories: ["project-management"],
  docsUrl: "https://linear.app/docs/mcp",
  authMode: "mcp_oauth",
  auth: {
    defaultScopes: [],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "mcp",
    serverUrl: "https://mcp.linear.app/mcp",
  },
  memberConnectable: true,
} satisfies ProviderDefInput;
