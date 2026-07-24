import type { ProviderDefInput } from "#/schema.js";

export const asanaProvider = {
  key: "asana",
  displayName: "Asana",
  description:
    "Find, create, and update tasks and projects in Asana. Tools come from Asana's official MCP server.",
  logoUrl: "/connector-logos/asana.svg",
  categories: ["project-management"],
  docsUrl: "https://developers.asana.com/docs/mcp-server",
  authMode: "mcp_oauth",
  auth: {
    defaultScopes: [],
    // Asana's token response nests the authorizing user's stable GID.
    accountIdentityFields: ["data.gid"],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "mcp",
    // V1 (https://mcp.asana.com/sse) is deprecated; V2 is the supported endpoint.
    serverUrl: "https://mcp.asana.com/v2/mcp",
  },
  memberConnectable: true,
} satisfies ProviderDefInput;
