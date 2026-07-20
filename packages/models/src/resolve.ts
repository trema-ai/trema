import type { ModelRef } from "@trema/harness";
import type { LanguageModel } from "ai";

import type { ModelEndpoint, ModelEndpoints } from "./endpoints.js";
import { resolveOpenAICompatible } from "./resolvers/openai-compatible.js";

export interface ResolvedModel {
  endpointName: string;
  endpoint: ModelEndpoint;
  model: LanguageModel;
}

function selectEndpoint(endpoints: ModelEndpoints, ref: ModelRef): [string, ModelEndpoint] {
  if (ref.provider !== undefined) {
    const endpoint = endpoints[ref.provider];
    if (endpoint === undefined) {
      throw new Error(`Unknown model endpoint: ${ref.provider}`);
    }
    return [ref.provider, endpoint];
  }

  const entries = Object.entries(endpoints);
  if (entries.length !== 1) {
    throw new Error(
      `Model provider is required when ${entries.length === 0 ? "no endpoints are" : "multiple endpoints are"} configured`,
    );
  }
  return entries[0] as [string, ModelEndpoint];
}

export function resolveModel(
  endpoints: ModelEndpoints,
  ref: ModelRef,
  fetch?: typeof globalThis.fetch,
): ResolvedModel {
  const [endpointName, endpoint] = selectEndpoint(endpoints, ref);

  switch (endpoint.protocol) {
    case "openai-compatible":
      return {
        endpointName,
        endpoint,
        model: resolveOpenAICompatible({
          endpointName,
          endpoint,
          modelId: ref.id,
          ...(fetch === undefined ? {} : { fetch }),
        }),
      };
  }

  throw new Error(`Unsupported model endpoint protocol: ${(endpoint as { protocol: string }).protocol}`);
}
