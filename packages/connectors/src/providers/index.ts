import { asanaProvider } from "#/providers/asana.js";
import { figmaProvider } from "#/providers/figma.js";
import { githubProvider } from "#/providers/github.js";
import { googleWorkspaceProvider } from "#/providers/google_workspace.js";
import { hubspotProvider } from "#/providers/hubspot.js";
import { linearProvider } from "#/providers/linear.js";
import { notionMcpProvider } from "#/providers/notion-mcp.js";
import { sentryProvider } from "#/providers/sentry.js";
import { slackProvider } from "#/providers/slack.js";
import { stripeProvider } from "#/providers/stripe.js";
import { zendeskProvider } from "#/providers/zendesk.js";
import type { ProviderDefInput } from "#/schema.js";

export {
  asanaProvider,
  figmaProvider,
  githubProvider,
  googleWorkspaceProvider,
  hubspotProvider,
  linearProvider,
  notionMcpProvider,
  sentryProvider,
  slackProvider,
  stripeProvider,
  zendeskProvider,
};

export const providerDefinitions = [
  asanaProvider,
  figmaProvider,
  githubProvider,
  googleWorkspaceProvider,
  hubspotProvider,
  linearProvider,
  notionMcpProvider,
  sentryProvider,
  slackProvider,
  stripeProvider,
  zendeskProvider,
] as const satisfies readonly ProviderDefInput[];
