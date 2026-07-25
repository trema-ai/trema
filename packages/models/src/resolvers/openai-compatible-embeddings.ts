import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import type { EmbeddingModel } from "ai";

import type { OpenAICompatibleEmbeddingEndpoint } from "#models/embedding-port.js";

export function resolveOpenAICompatibleEmbeddingModel(input: {
  endpointName: string;
  endpoint: OpenAICompatibleEmbeddingEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): EmbeddingModel {
  const provider = createOpenAICompatible({
    name: input.endpointName,
    baseURL: input.endpoint.baseUrl,
    ...(input.endpoint.apiKey === undefined ? {} : { apiKey: input.endpoint.apiKey }),
    ...(input.endpoint.headers === undefined ? {} : { headers: input.endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return provider.embeddingModel(input.modelId);
}
