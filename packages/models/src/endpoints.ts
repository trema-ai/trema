export interface OpenAICompatibleEndpoint {
  protocol: "openai-compatible";
  baseUrl: string;
  apiKey: string;
  headers?: Record<string, string>;
}

/** Add future protocols as new members of this union. */
export type ModelEndpoint = OpenAICompatibleEndpoint;

export type ModelEndpoints = Record<string, ModelEndpoint>;
