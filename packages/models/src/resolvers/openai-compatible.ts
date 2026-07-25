import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { LanguageModel } from "ai";

import type { OpenAICompatibleEndpoint } from "#models/endpoints.js";

export function resolveOpenAICompatible(input: {
  endpointName: string;
  endpoint: OpenAICompatibleEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  const provider = createOpenAICompatible({
    name: input.endpointName,
    baseURL: input.endpoint.baseUrl,
    apiKey: input.endpoint.apiKey,
    ...(input.endpoint.headers === undefined ? {} : { headers: input.endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
    includeUsage: true,
  });
  return provider(input.modelId);
}
