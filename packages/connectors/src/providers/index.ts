import { airtableProvider } from "#connectors/providers/airtable.js";
import { apolloProvider } from "#connectors/providers/apollo.js";
import { asanaProvider } from "#connectors/providers/asana.js";
import { boxProvider } from "#connectors/providers/box.js";
import { canvaProvider } from "#connectors/providers/canva.js";
import { clickupProvider } from "#connectors/providers/clickup.js";
import { docusignProvider } from "#connectors/providers/docusign.js";
import { dropboxProvider } from "#connectors/providers/dropbox.js";
import { figmaProvider } from "#connectors/providers/figma.js";
import { gammaProvider } from "#connectors/providers/gamma.js";
import { githubProvider } from "#connectors/providers/github.js";
import { googleWorkspaceProvider } from "#connectors/providers/google_workspace.js";
import { granolaProvider } from "#connectors/providers/granola.js";
import { hubspotProvider } from "#connectors/providers/hubspot.js";
import { intercomProvider } from "#connectors/providers/intercom.js";
import { linearProvider } from "#connectors/providers/linear.js";
import { lucidProvider } from "#connectors/providers/lucid.js";
import { miroProvider } from "#connectors/providers/miro.js";
import { mondayProvider } from "#connectors/providers/monday.js";
import { n8nProvider } from "#connectors/providers/n8n.js";
import { netsuiteProvider } from "#connectors/providers/netsuite.js";
import { notionMcpProvider } from "#connectors/providers/notion-mcp.js";
import { posthogProvider } from "#connectors/providers/posthog.js";
import { sentryProvider } from "#connectors/providers/sentry.js";
import { slackProvider } from "#connectors/providers/slack.js";
import { stripeProvider } from "#connectors/providers/stripe.js";
import { supabaseProvider } from "#connectors/providers/supabase.js";
import { vercelProvider } from "#connectors/providers/vercel.js";
import { zapierProvider } from "#connectors/providers/zapier.js";
import { zendeskProvider } from "#connectors/providers/zendesk.js";
import type { ProviderDefInput } from "#connectors/schema.js";

export {
  airtableProvider,
  apolloProvider,
  asanaProvider,
  boxProvider,
  canvaProvider,
  clickupProvider,
  docusignProvider,
  dropboxProvider,
  figmaProvider,
  gammaProvider,
  githubProvider,
  googleWorkspaceProvider,
  granolaProvider,
  hubspotProvider,
  intercomProvider,
  linearProvider,
  lucidProvider,
  miroProvider,
  mondayProvider,
  n8nProvider,
  netsuiteProvider,
  notionMcpProvider,
  posthogProvider,
  sentryProvider,
  slackProvider,
  stripeProvider,
  supabaseProvider,
  vercelProvider,
  zapierProvider,
  zendeskProvider,
};

export const providerDefinitions = [
  airtableProvider,
  apolloProvider,
  asanaProvider,
  boxProvider,
  canvaProvider,
  clickupProvider,
  docusignProvider,
  dropboxProvider,
  figmaProvider,
  gammaProvider,
  githubProvider,
  googleWorkspaceProvider,
  granolaProvider,
  hubspotProvider,
  intercomProvider,
  linearProvider,
  lucidProvider,
  miroProvider,
  mondayProvider,
  n8nProvider,
  netsuiteProvider,
  notionMcpProvider,
  posthogProvider,
  sentryProvider,
  slackProvider,
  stripeProvider,
  supabaseProvider,
  vercelProvider,
  zapierProvider,
  zendeskProvider,
] as const satisfies readonly ProviderDefInput[];
