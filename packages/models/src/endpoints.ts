/** Connection settings for an OpenAI-compatible model endpoint. */
export interface OpenAICompatibleEndpoint {
  /** Selects the OpenAI-compatible resolver. */
  protocol: "openai-compatible";
  /** Base endpoint address passed to the model provider. */
  baseUrl: string;
  /** Omitted for endpoints that need no key, such as a server on the same host. */
  apiKey?: string;
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/** Connection settings for an Anthropic-protocol model endpoint. */
export interface AnthropicEndpoint {
  /** Selects the Anthropic resolver. */
  protocol: "anthropic";
  /**
   * Base endpoint address passed to the model provider. Required, because a
   * registry row always carries one and the Anthropic-compatible gateways this
   * protocol also serves do not answer at the vendor's own address.
   */
  baseUrl: string;
  /**
   * Sent as the key header this protocol names. Omitting it does not mean no
   * credential: the SDK then looks for one in its own environment variable and
   * fails the call when that is unset too.
   */
  apiKey?: string;
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/** Connection settings for a Google-protocol (Gemini API) model endpoint. */
export interface GoogleEndpoint {
  /** Selects the Google resolver. */
  protocol: "google";
  /**
   * Base endpoint address passed to the model provider. Required, because a
   * registry row always carries one and this protocol's address names an API
   * version a deployment may need to pin.
   */
  baseUrl: string;
  /**
   * Sent as the key header this protocol names. Omitting it does not mean no
   * credential: the SDK then looks for one in its own environment variable and
   * fails the call when that is unset too.
   */
  apiKey?: string;
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/**
 * Connection settings for an OpenAI Responses model endpoint.
 *
 * Separate from the OpenAI-compatible member because the wire shape is a
 * different one: a request is a Responses call, not a chat completion, and the
 * answer comes back as output items — reasoning summaries among them — rather
 * than as choices. Azure OpenAI is why the arm exists at all. Its v1 surface
 * serves the Responses API at a per-resource address, and the plain OpenAI
 * vendor stays on the OpenAI-compatible member, which every gateway also
 * speaks.
 */
export interface OpenAIResponsesEndpoint {
  /** Selects the OpenAI Responses resolver. */
  protocol: "openai-responses";
  /**
   * Base endpoint address passed to the model provider. Required, because a
   * registry row always carries one and this protocol's chief consumer answers
   * at an address that names the customer's own resource.
   */
  baseUrl: string;
  /**
   * Sent as the bearer token this protocol names. Omitting it does not mean no
   * credential: the SDK then looks for one in its own environment variable and
   * fails the call when that is unset too.
   */
  apiKey?: string;
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/**
 * Connection settings for an AWS Bedrock endpoint, authenticated with SigV4.
 *
 * The only member so far whose credential is not one string: SigV4 signs with a
 * key pair, optionally a session token, and always a region. It is also the
 * only member that needs configuration beside the address, which is why the
 * registry row it comes from carries a settings column.
 */
export interface BedrockEndpoint {
  /** Selects the Bedrock resolver. */
  protocol: "bedrock";
  /**
   * The runtime address model calls are made against. Required, because a
   * registry row always carries one and a deployment reaching Bedrock through a
   * VPC endpoint or a gateway answers somewhere other than the regional host.
   */
  baseUrl: string;
  /**
   * The region requests are signed for. Stated separately from the address
   * because a signature names a region whatever host serves the call, and a
   * private endpoint's name does not carry one to read.
   */
  region: string;
  /**
   * The access key half of the signing pair. Omitting it — with the secret —
   * means ambient credentials: the SDK then reads the environment the worker
   * runs in, which is how an instance or task role signs without a stored key.
   */
  accessKeyId?: string;
  /** The secret half of the signing pair. Travels with `accessKeyId` or not at all. */
  secretAccessKey?: string;
  /** The session token temporary credentials carry. Absent for long-lived keys. */
  sessionToken?: string;
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/**
 * Connection settings for a Google Vertex endpoint.
 *
 * The second member whose credential is not one string, and the first whose
 * address is not the whole address: Vertex serves models under a project and a
 * location both, so those travel as their own fields and the resolver composes
 * the resource path from them. Storing the key material is optional — a row
 * that stores none leaves the provider its own credential chain, which is how a
 * workload identity answers without a key ever being pasted anywhere.
 */
export interface VertexEndpoint {
  /** Selects the Vertex resolver. */
  protocol: "vertex";
  /**
   * The API surface both model calls and the model listing are made against —
   * the host and the version, not the resource path under them. Required,
   * because a registry row always carries one and a regional host, a private
   * endpoint, and a pinned API version are all stated here rather than guessed.
   */
  baseUrl: string;
  /** The Google Cloud project whose models are addressed, and whose quota they spend. */
  project: string;
  /** The Vertex location the models are addressed in, such as `us-central1`. */
  location: string;
  /**
   * The service-account material an access token is minted from: the two fields
   * of a downloaded key file that a token exchange needs, and no more. Omitting
   * it means ambient credentials — the provider then reads whatever the worker
   * itself can reach, a metadata server or a mounted key file, which is the
   * application-default configuration the credential mode allows.
   */
  serviceAccount?: { clientEmail: string; privateKey: string };
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/** Add future protocols as new members of this union. */
export type ModelEndpoint =
  | OpenAICompatibleEndpoint
  | AnthropicEndpoint
  | GoogleEndpoint
  | OpenAIResponsesEndpoint
  | BedrockEndpoint
  | VertexEndpoint;

/** Named endpoints available to the model port. */
export type ModelEndpoints = Record<string, ModelEndpoint>;
