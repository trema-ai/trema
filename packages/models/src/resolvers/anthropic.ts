import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";

import type { AnthropicEndpoint } from "#models/endpoints.js";

/**
 * The provider is left under its own name rather than the endpoint's: it reads
 * request options and writes response metadata under the `anthropic` key
 * whatever a deployment calls the endpoint, which is the difference from the
 * OpenAI-compatible resolver.
 */
export function resolveAnthropic(input: {
  endpoint: AnthropicEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  const provider = createAnthropic({
    baseURL: input.endpoint.baseUrl,
    ...(input.endpoint.apiKey === undefined ? {} : { apiKey: input.endpoint.apiKey }),
    ...(input.endpoint.headers === undefined ? {} : { headers: input.endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return provider(input.modelId);
}
