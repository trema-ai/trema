import type { ModelCredentialMode, ModelProtocol } from "#server/generated/prisma/client.js";
import type { ModelProviderSettings } from "#server/services/model-providers/index.js";

/**
 * A bundled provider, ready to be stored as a registry row. A vendor is a preset
 * over a protocol, never code: shipping a new one is an edit to this file.
 */
export interface ModelProviderPreset {
  /** The provider name the screen suggests. An admin may store it under another. */
  name: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  credentialMode: ModelCredentialMode;
  /** Which bundled brand mark the screen draws. Absent falls back to a neutral one. */
  icon?: string;
  /**
   * Query parameters this vendor's model listing needs to answer in full. A
   * listing that filters its own catalog is a vendor fact, and this is where a
   * vendor fact belongs: preset data seeded onto the row, never a branch in the
   * protocol's listing code.
   */
  listQuery?: Record<string, string>;
  /**
   * The protocol configuration this vendor's rows need, for the protocols that
   * take any. Seeded like the base URL and editable the same way: it is a
   * starting value, not a fact about the customer's deployment.
   */
  settings?: ModelProviderSettings;
}

// No model lists here on purpose: a provider is asked what it serves, so a
// hand-kept copy would only go stale.
export const modelProviderPresets: ModelProviderPreset[] = [
  {
    name: "openai",
    label: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    credentialMode: "api_key",
    icon: "openai",
  },
  // The one preset whose base URL an admin must edit before saving: the address
  // names their own Azure resource, so the host below is a placeholder and
  // nothing else. Seeding it is still worth doing, because the dialog fills an
  // editable field and the shape of the address — the `/openai/v1` suffix the
  // v1 surface answers at — is the part that is easy to get wrong.
  //
  // The credential goes over as a bearer token, which is what that surface
  // takes from a plain OpenAI client; the compatibility is the point of it. A
  // deployment fronted by something that insists on Azure's older `api-key`
  // header instead can add that header on the row itself — no vendor branch
  // belongs in the protocol's code.
  {
    name: "azure-openai",
    label: "Azure OpenAI",
    protocol: "openai_responses",
    baseUrl: "https://your-resource.openai.azure.com/openai/v1",
    credentialMode: "api_key",
    icon: "azure",
  },
  {
    name: "anthropic",
    label: "Anthropic",
    protocol: "anthropic",
    baseUrl: "https://api.anthropic.com/v1",
    credentialMode: "api_key",
    icon: "anthropic",
  },
  {
    name: "google",
    label: "Google",
    protocol: "google",
    baseUrl: "https://generativelanguage.googleapis.com/v1beta",
    credentialMode: "api_key",
    icon: "gemini",
    // The listing pages, fifty models at a time, and takes a page size up to a
    // thousand. Asking for the maximum buys the whole catalog in the one call
    // the refresh makes; the tradeoff accepted here is that a catalog past a
    // thousand models would come back truncated, silently, because nothing
    // follows the page token. That is the trade we want while the alternative
    // is teaching the protocol's listing code to walk pages for one vendor.
    listQuery: { pageSize: "1000" },
  },
  // Bedrock is reached at a regional runtime address, and the region is stated
  // twice on purpose: once in the host below, which an admin edits for their
  // own deployment or replaces with a VPC endpoint, and once as the setting
  // every signature names whatever host ends up answering.
  {
    name: "bedrock",
    label: "AWS Bedrock",
    protocol: "bedrock",
    baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
    credentialMode: "aws_sigv4",
    icon: "bedrock",
    settings: { region: "us-east-1" },
  },
  // The second preset an admin must edit before saving, after Azure: the
  // project below names nobody's project, and the region appears twice — in the
  // regional host and again as the location models are addressed in — because a
  // deployment reaching Vertex through a private endpoint keeps the second
  // while replacing the first.
  //
  // The base URL names the beta surface deliberately. It is the version the
  // provider addresses models at by default, and the only one that serves the
  // Model Garden listing this protocol's catalog refresh reads.
  {
    name: "vertex",
    label: "Google Vertex",
    protocol: "vertex",
    baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
    credentialMode: "gcp_adc",
    icon: "vertex",
    settings: { project: "your-project-id", location: "us-central1" },
    // The listing pages the way every Google list call does, and takes the
    // standard page size. Asking for a thousand buys the whole publisher
    // catalog in the one call the refresh makes; a server that caps lower
    // answers with its own maximum rather than refusing, which is the standard
    // list convention. The tradeoff is the Gemini preset's: a catalog past the
    // cap comes back truncated, because nothing follows the page token.
    listQuery: { pageSize: "1000" },
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    protocol: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialMode: "api_key",
    icon: "openrouter",
    // The listing filters by output modality and defaults to text, so a plain
    // call answers with no embedding models at all — 343 of them against 447
    // when this was checked. Asking for every modality is what makes the
    // embedding half of the catalog visible.
    listQuery: { output_modalities: "all" },
  },
  {
    name: "groq",
    label: "Groq",
    protocol: "openai_compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    credentialMode: "api_key",
    icon: "groq",
  },
  {
    name: "mistral",
    label: "Mistral",
    protocol: "openai_compatible",
    baseUrl: "https://api.mistral.ai/v1",
    credentialMode: "api_key",
    icon: "mistral",
  },
  {
    name: "local",
    label: "Local model server",
    protocol: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    credentialMode: "none",
    icon: "ollama",
  },
];

export function listPresets(): ModelProviderPreset[] {
  return modelProviderPresets;
}
