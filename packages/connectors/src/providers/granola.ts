import type { ProviderDefInput } from "#connectors/schema.js";

export const granolaProvider = {
  key: "granola",
  trusted: true,
  displayName: "Granola",
  description:
    "Search meeting notes, folders, summaries, and transcripts. Tools come from Granola's official MCP server.",
  logoUrl: "/connector-logos/granola.svg",
  categories: ["knowledge-management", "productivity"],
  docsUrl: "https://docs.granola.ai/help-center/sharing/integrations/mcp",
  authMode: "mcp_oauth",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.granola.ai/mcp" },
  memberConnectable: true,
} satisfies ProviderDefInput;
