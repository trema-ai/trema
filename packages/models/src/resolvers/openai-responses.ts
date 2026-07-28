import { createOpenAI } from "@ai-sdk/openai";
import type { LanguageModel } from "ai";

import type { OpenAIResponsesEndpoint } from "#models/endpoints.js";

/**
 * The provider is left under its own name rather than the endpoint's, as on the
 * Anthropic and Google protocols and for the sharpest reason of the three: this
 * provider picks its options key by looking for `azure` in its name, so naming
 * it after the endpoint would move request options and response metadata to
 * another key the moment an admin stored the Azure preset under its suggested
 * name. Left alone, the key is `openai`.
 *
 * The model asked for is the Responses one explicitly. The provider's callable
 * form resolves to it today, but `responses()` says on the page which wire
 * shape this protocol member exists to speak.
 */
export function resolveOpenAIResponses(input: {
  endpoint: OpenAIResponsesEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  const provider = createOpenAI({
    baseURL: input.endpoint.baseUrl,
    ...(input.endpoint.apiKey === undefined ? {} : { apiKey: input.endpoint.apiKey }),
    ...(input.endpoint.headers === undefined ? {} : { headers: input.endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return provider.responses(input.modelId);
}
