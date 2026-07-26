import type { ModelCredentialMode, ModelProtocol } from "#server/generated/prisma/client.js";
import type { ModelCatalogEntry } from "#server/services/model-providers/index.js";

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
  catalog: ModelCatalogEntry[];
}

// Context windows are left out on purpose. They move with every model snapshot,
// a wrong number here would be read as fact, and the field is editable per row.
export const modelProviderPresets: ModelProviderPreset[] = [
  {
    name: "openai",
    label: "OpenAI",
    protocol: "openai_compatible",
    baseUrl: "https://api.openai.com/v1",
    credentialMode: "api_key",
    icon: "openai",
    catalog: [
      { id: "gpt-5", label: "GPT-5", roles: ["turns", "utility"] },
      { id: "gpt-5-mini", label: "GPT-5 mini", roles: ["turns", "utility"] },
      { id: "gpt-4.1", label: "GPT-4.1", roles: ["turns", "utility"] },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", roles: ["utility"] },
      { id: "text-embedding-3-small", label: "Embedding 3 small", roles: ["embed"] },
      { id: "text-embedding-3-large", label: "Embedding 3 large", roles: ["embed"] },
    ],
  },
  {
    name: "openrouter",
    label: "OpenRouter",
    protocol: "openai_compatible",
    baseUrl: "https://openrouter.ai/api/v1",
    credentialMode: "api_key",
    icon: "openrouter",
    catalog: [
      { id: "openai/gpt-5", label: "GPT-5", roles: ["turns", "utility"] },
      {
        id: "anthropic/claude-sonnet-4.5",
        label: "Claude Sonnet 4.5",
        roles: ["turns", "utility"],
      },
      { id: "google/gemini-2.5-pro", label: "Gemini 2.5 Pro", roles: ["turns", "utility"] },
      {
        id: "meta-llama/llama-3.3-70b-instruct",
        label: "Llama 3.3 70B Instruct",
        roles: ["turns", "utility"],
      },
    ],
  },
  {
    name: "groq",
    label: "Groq",
    protocol: "openai_compatible",
    baseUrl: "https://api.groq.com/openai/v1",
    credentialMode: "api_key",
    icon: "groq",
    catalog: [
      { id: "llama-3.3-70b-versatile", label: "Llama 3.3 70B", roles: ["turns", "utility"] },
      { id: "openai/gpt-oss-120b", label: "GPT-OSS 120B", roles: ["turns", "utility"] },
      { id: "moonshotai/kimi-k2-instruct", label: "Kimi K2 Instruct", roles: ["turns", "utility"] },
    ],
  },
  {
    name: "mistral",
    label: "Mistral",
    protocol: "openai_compatible",
    baseUrl: "https://api.mistral.ai/v1",
    credentialMode: "api_key",
    icon: "mistral",
    catalog: [
      { id: "mistral-large-latest", label: "Mistral Large", roles: ["turns", "utility"] },
      { id: "mistral-small-latest", label: "Mistral Small", roles: ["turns", "utility"] },
      { id: "mistral-embed", label: "Mistral Embed", roles: ["embed"] },
    ],
  },
  {
    name: "local",
    label: "Local model server",
    protocol: "openai_compatible",
    baseUrl: "http://localhost:11434/v1",
    credentialMode: "none",
    icon: "ollama",
    catalog: [
      { id: "llama3.1:8b", label: "Llama 3.1 8B", roles: ["turns", "utility"] },
      { id: "nomic-embed-text", label: "Nomic Embed Text", roles: ["embed"] },
    ],
  },
];

export function listPresets(): ModelProviderPreset[] {
  return modelProviderPresets;
}
