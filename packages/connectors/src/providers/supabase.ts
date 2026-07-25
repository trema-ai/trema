import type { ProviderDefInput } from "#connectors/schema.js";

export const supabaseProvider = {
  key: "supabase",
  displayName: "Supabase",
  description:
    "Manage Supabase projects, databases, migrations, functions, and logs through its MCP server.",
  logoUrl: "/connector-logos/supabase.svg",
  categories: ["developer-tools"],
  docsUrl: "https://supabase.com/docs/guides/ai-tools/mcp",
  authMode: "mcp_oauth",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {},
  transport: { type: "mcp", serverUrl: "https://mcp.supabase.com/mcp" },
  memberConnectable: true,
} satisfies ProviderDefInput;
