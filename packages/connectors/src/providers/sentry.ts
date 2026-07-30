import type { ProviderDefInput } from "#connectors/schema.js";

export const sentryProvider = {
  key: "sentry",
  trusted: true,
  displayName: "Sentry",
  description:
    "Investigate issues, errors, and releases in Sentry. Tools come from Sentry's official MCP server.",
  logoUrl: "/connector-logos/sentry.svg",
  categories: ["developer-tools"],
  docsUrl: "https://docs.sentry.io/product/sentry-mcp/",
  authMode: "mcp_oauth",
  oauthActor: "user",
  auth: {
    defaultScopes: [],
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "mcp",
    serverUrl: "https://mcp.sentry.dev/mcp",
  },
} satisfies ProviderDefInput;
