import { airtableProvider } from "#/providers/airtable.js";
import { apolloProvider } from "#/providers/apollo.js";
import { asanaProvider } from "#/providers/asana.js";
import { boxProvider } from "#/providers/box.js";
import { canvaProvider } from "#/providers/canva.js";
import { clickupProvider } from "#/providers/clickup.js";
import { docusignProvider } from "#/providers/docusign.js";
import { dropboxProvider } from "#/providers/dropbox.js";
import { figmaProvider } from "#/providers/figma.js";
import { gammaProvider } from "#/providers/gamma.js";
import { githubProvider } from "#/providers/github.js";
import { granolaProvider } from "#/providers/granola.js";
import { hubspotProvider } from "#/providers/hubspot.js";
import { intercomProvider } from "#/providers/intercom.js";
import { linearProvider } from "#/providers/linear.js";
import { lucidProvider } from "#/providers/lucid.js";
import { miroProvider } from "#/providers/miro.js";
import { mondayProvider } from "#/providers/monday.js";
import { n8nProvider } from "#/providers/n8n.js";
import { netsuiteProvider } from "#/providers/netsuite.js";
import { notionMcpProvider } from "#/providers/notion-mcp.js";
import { posthogProvider } from "#/providers/posthog.js";
import { sentryProvider } from "#/providers/sentry.js";
import { slackProvider } from "#/providers/slack.js";
import { stripeProvider } from "#/providers/stripe.js";
import { supabaseProvider } from "#/providers/supabase.js";
import { vercelProvider } from "#/providers/vercel.js";
import { zapierProvider } from "#/providers/zapier.js";
import { zendeskProvider } from "#/providers/zendesk.js";
import type { ProviderDefInput } from "#/schema.js";

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
