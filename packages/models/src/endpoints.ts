/** Connection settings for an OpenAI-compatible model endpoint. */
export interface OpenAICompatibleEndpoint {
  /** Selects the OpenAI-compatible resolver. */
  protocol: "openai-compatible";
  /** Base endpoint address passed to the model provider. */
  baseUrl: string;
  /** Authentication key passed to the model provider. */
  apiKey: string;
  /** Additional headers sent with model requests. */
  headers?: Record<string, string>;
}

/** Add future protocols as new members of this union. */
export type ModelEndpoint = OpenAICompatibleEndpoint;

/** Named endpoints available to the model port. */
export type ModelEndpoints = Record<string, ModelEndpoint>;
