import type { ModelCredentialMode, ModelProtocol } from "#server/generated/prisma/client.js";

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
