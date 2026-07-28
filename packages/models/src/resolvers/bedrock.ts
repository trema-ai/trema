import { createAmazonBedrock } from "@ai-sdk/amazon-bedrock";
import type { LanguageModel } from "ai";

import type { BedrockEndpoint } from "#models/endpoints.js";

/**
 * The provider is left under its own name rather than the endpoint's, as on the
 * other vendor protocols: it reads request options under `bedrock` and writes
 * response metadata under it too, whatever a deployment calls the endpoint.
 *
 * The key pair is passed only when the row carries one. Left out, the provider
 * signs with whatever the process can already reach — the AWS environment
 * variables an instance or task role populates — which is the ambient-role
 * configuration the credential mode allows. That fallback is the run path's
 * alone: the listing call in `apps/server` speaks for one row and spends that
 * row's own credential or none.
 */
export function resolveBedrock(input: {
  endpoint: BedrockEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  const { endpoint } = input;
  const provider = createAmazonBedrock({
    baseURL: endpoint.baseUrl,
    region: endpoint.region,
    ...(endpoint.accessKeyId === undefined ? {} : { accessKeyId: endpoint.accessKeyId }),
    ...(endpoint.secretAccessKey === undefined
      ? {}
      : { secretAccessKey: endpoint.secretAccessKey }),
    ...(endpoint.sessionToken === undefined ? {} : { sessionToken: endpoint.sessionToken }),
    ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return provider(input.modelId);
}
