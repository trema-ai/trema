import type { ProviderDefInput } from "#/schema.js";

export const apolloProvider = {
  key: "apollo",
  displayName: "Apollo",
  description:
    "Search and engage prospects, accounts, contacts, and sequences through Apollo's MCP server.",
  logoUrl: "/connector-logos/apollo.svg",
  categories: ["crm"],
  docsUrl: "https://docs.apollo.io/docs/apollo-mcp",
  authMode: "mcp_oauth",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.apollo.io/mcp" },
  memberConnectable: true,
} satisfies ProviderDefInput;
