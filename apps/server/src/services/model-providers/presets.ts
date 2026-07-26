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
