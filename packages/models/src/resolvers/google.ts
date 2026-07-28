import { createGoogleGenerativeAI } from "@ai-sdk/google";
import type { LanguageModel } from "ai";

import type { GoogleEndpoint } from "#models/endpoints.js";

/**
 * The provider is left under its own name rather than the endpoint's, as on the
 * Anthropic protocol and for a sharper reason: this provider picks its options
 * key by looking for `vertex` in its name, so naming it after the endpoint
 * would move request options and response metadata to another key the moment an
 * admin stored a row called `vertex-proxy`. Left alone, the key is `google`.
 */
export function resolveGoogle(input: {
  endpoint: GoogleEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  const provider = createGoogleGenerativeAI({
    baseURL: input.endpoint.baseUrl,
    ...(input.endpoint.apiKey === undefined ? {} : { apiKey: input.endpoint.apiKey }),
    ...(input.endpoint.headers === undefined ? {} : { headers: input.endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return provider(input.modelId);
}
