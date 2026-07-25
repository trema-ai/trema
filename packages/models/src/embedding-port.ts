/** Connection settings for an OpenAI-compatible embeddings endpoint. */
export interface OpenAICompatibleEmbeddingEndpoint {
  /** Selects the OpenAI-compatible resolver. */
  protocol: "openai-compatible";
  /** Base endpoint address, including the version path. */
  baseUrl: string;
  /** Omitted for endpoints that need no key, such as a server on the same host. */
  apiKey?: string;
  /** Additional headers sent with embedding requests. */
  headers?: Record<string, string>;
}

/** Add future protocols as new members of this union. */
export type EmbeddingEndpoint = OpenAICompatibleEmbeddingEndpoint;

export interface EmbedRequest {
  /** The model that produces the vectors. */
  model: string;
  /** The texts to embed. One vector comes back per text, in order. */
  input: string[];
}

export interface EmbedResult {
  vectors: number[][];
}

/** The narrow port every embedding adapter implements. */
export interface EmbeddingPort {
  embed(request: EmbedRequest): Promise<EmbedResult>;
}

export class EmbeddingCallError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "EmbeddingCallError";
    this.retryable = retryable;
  }
}
