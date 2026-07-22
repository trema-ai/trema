import { githubProvider } from "#/services/connectors/providers/github.js";
import { linearProvider } from "#/services/connectors/providers/linear.js";
import { notionMcpProvider } from "#/services/connectors/providers/notion-mcp.js";
import type { ProviderDefInput } from "#/services/connectors/schema.js";

export { githubProvider, linearProvider, notionMcpProvider };

export const providerDefinitions = [
  githubProvider,
  linearProvider,
  notionMcpProvider,
] as const satisfies readonly ProviderDefInput[];
