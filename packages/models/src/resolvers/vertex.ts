import { createVertex } from "@ai-sdk/google-vertex";
import type { LanguageModel } from "ai";

import type { VertexEndpoint } from "#models/endpoints.js";

/**
 * What the provider takes for authentication, borrowed from its own signature
 * rather than from `google-auth-library` directly — the credential chain is the
 * provider's dependency, not this package's.
 */
type GoogleAuthOptions = NonNullable<
  NonNullable<Parameters<typeof createVertex>[0]>["googleAuthOptions"]
>;

/**
 * The node entrypoint rather than the edge one. Both reach the same API; only
 * the node build carries Google's own credential chain, and that chain is
 * exactly what an endpoint storing no key material asks for. The edge build
 * takes a service account and nothing else, so choosing it would have made the
 * ambient half of this credential mode unreachable.
 *
 * The provider is left under its own name rather than the endpoint's, as on the
 * other vendor protocols, and here the name is load-bearing twice over. The
 * model this provider builds is the Gemini one, which picks its options key by
 * looking for `vertex` in the provider's name: named as it names itself, it
 * reads `googleVertex` first and `vertex` after it, and an endpoint called
 * anything else would move both to `google` without saying so.
 */
export function resolveVertex(input: {
  endpoint: VertexEndpoint;
  modelId: string;
  fetch?: typeof globalThis.fetch;
}): LanguageModel {
  const { endpoint } = input;
  const googleAuthOptions: GoogleAuthOptions = {
    ...(endpoint.serviceAccount === undefined
      ? {}
      : {
          credentials: {
            client_email: endpoint.serviceAccount.clientEmail,
            private_key: endpoint.serviceAccount.privateKey,
          },
        }),
    // The token exchange goes through the same fetch the model call does. One
    // function is where a deployment says how this package reaches the network,
    // and a credential exchange that went around it would be the single call it
    // could neither see nor route.
    ...(input.fetch === undefined
      ? {}
      : { clientOptions: { transporterOptions: { fetchImplementation: input.fetch } } }),
  };
  const provider = createVertex({
    project: endpoint.project,
    location: endpoint.location,
    // The provider composes this address for itself only when it is given none,
    // and a registry row always gives one. So the resource path is composed
    // here instead: the stored base URL is the API surface, and a model on it
    // lives under a project and a location.
    baseURL: `${endpoint.baseUrl}/projects/${endpoint.project}/locations/${endpoint.location}/publishers/google`,
    ...(Object.keys(googleAuthOptions).length === 0 ? {} : { googleAuthOptions }),
    ...(endpoint.headers === undefined ? {} : { headers: endpoint.headers }),
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  return provider(input.modelId);
}
