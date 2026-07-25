import { embedMany } from "ai";

import type {
  EmbeddingEndpoint,
  EmbeddingPort,
  EmbedRequest,
  EmbedResult,
} from "#models/embedding-port.js";
import { EmbeddingCallError } from "#models/embedding-port.js";
import { modelErrorData } from "#models/errors.js";
import { resolveOpenAICompatibleEmbeddingModel } from "#models/resolvers/openai-compatible-embeddings.js";

const defaultTimeoutMs = 5_000;
const defaultEndpointName = "embeddings";

/** Configuration for the AI SDK embedding port. */
export interface SdkEmbeddingPortOptions {
  /** The endpoint the vectors come from. */
  endpoint: EmbeddingEndpoint;
  /** Abandon a request after this long. Defaults to five seconds. */
  timeoutMs?: number;
  /** Optional fetch implementation for hosts that mediate outbound traffic. */
  fetch?: typeof globalThis.fetch;
}

export function createSdkEmbeddingPort(options: SdkEmbeddingPortOptions): EmbeddingPort {
  return {
    async embed(request: EmbedRequest): Promise<EmbedResult> {
      if (request.input.length === 0) return { vectors: [] };

      const model = resolveOpenAICompatibleEmbeddingModel({
        endpointName: defaultEndpointName,
        endpoint: options.endpoint,
        modelId: request.model,
        ...(options.fetch === undefined ? {} : { fetch: options.fetch }),
      });

      try {
        const { embeddings } = await embedMany({
          model,
          values: request.input,
          // Callers treat a failure as "no vector this time" and repair later,
          // so a retry only spends the request budget twice.
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(options.timeoutMs ?? defaultTimeoutMs),
        });
        if (embeddings.length !== request.input.length) {
          throw new EmbeddingCallError(
            `Embedding endpoint returned ${embeddings.length} vectors for ${request.input.length} inputs`,
            false,
          );
        }
        return { vectors: embeddings };
      } catch (error) {
        if (error instanceof EmbeddingCallError) throw error;
        const { message, retryable } = modelErrorData(error);
        throw new EmbeddingCallError(message, retryable, { cause: error });
      }
    },
  };
}
