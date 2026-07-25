import type { ProviderDefInput } from "#connectors/schema.js";

export const airtableProvider = {
  key: "airtable",
  displayName: "Airtable",
  description:
    "Access bases, records, and workspace content. Tools come from Airtable's official MCP server.",
  logoUrl: "/connector-logos/airtable.svg",
  categories: ["productivity"],
  docsUrl: "https://support.airtable.com/v1/docs/using-the-airtable-mcp-server",
  authMode: "mcp_oauth",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.airtable.com/mcp" },
  memberConnectable: true,
} satisfies ProviderDefInput;
