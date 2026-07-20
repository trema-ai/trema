import type {
  CompleteRequest,
  CompleteResult,
  ModelPort,
  RunEventData,
  StopReason,
  TurnRequest,
  TurnResult,
  TurnStream,
} from "@trema/harness";
import type { FinishReason, LanguageModelUsage, ProviderMetadata } from "ai";

import { chunkToEvents, createChunkState } from "./chunk-to-events.js";
import type { ModelEndpoints } from "./endpoints.js";
import { isAbortFailure, modelErrorData } from "./errors.js";
import { resolveModel } from "./resolve.js";
import { defaultSdkOperations, toSdkTools } from "./sdk-operations.js";
import type { SdkCallOptions, SdkOperations } from "./sdk-operations.js";
import { toStopReason } from "./stop-reason.js";
import { thinkingProviderOptions } from "./thinking.js";
import type { ThinkingLevelMap } from "./thinking.js";
import { toModelMessages } from "./to-model-messages.js";
import { toUsage } from "./usage.js";

export interface SdkModelPortOptions {
  endpoints: ModelEndpoints;
  thinkingLevelMap?: ThinkingLevelMap;
  /** Optional fetch implementation for hosts that mediate outbound model traffic. */
  fetch?: typeof globalThis.fetch;
}

interface InternalOptions extends SdkModelPortOptions {
  operations: SdkOperations;
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve(value: T): void;
  reject(error: unknown): void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function callOptions(
  options: InternalOptions,
  request: TurnRequest | CompleteRequest,
): SdkCallOptions {
  const resolved = resolveModel(options.endpoints, request.model, options.fetch);
  const providerOptions = "thinking" in request
    ? thinkingProviderOptions({
        endpointName: resolved.endpointName,
        endpoint: resolved.endpoint,
        modelId: request.model.id,
        ...(request.thinking === undefined ? {} : { requested: request.thinking }),
        ...(options.thinkingLevelMap === undefined ? {} : { map: options.thinkingLevelMap }),
      })
    : undefined;
  return {
    model: resolved.model,
    messages: toModelMessages(request.instructions, request.messages),
    abortSignal: request.abort,
    ...(request.budget?.maxOutputTokens === undefined
      ? {}
      : { maxOutputTokens: request.budget.maxOutputTokens }),
    ...(providerOptions === undefined ? {} : { providerOptions }),
  };
}

class SdkModelPort implements ModelPort {
  readonly #options: InternalOptions;

  constructor(options: InternalOptions) {
    this.#options = options;
  }

  streamTurn(request: TurnRequest): TurnStream {
    const sdkOptions = callOptions(this.#options, request);
    Object.assign(sdkOptions, toSdkTools(request.tools));
    const completion = deferred<TurnResult>();
    const operations = this.#options.operations;

    return {
      result: completion.promise,
      async *[Symbol.asyncIterator](): AsyncIterator<RunEventData> {
        const state = createChunkState();
        let started = false;
        let finishReason: FinishReason | undefined;
        let usage: LanguageModelUsage | undefined;
        let providerMetadata: ProviderMetadata | undefined;
        let failure: ReturnType<typeof modelErrorData> | undefined;
        let stopReason: StopReason | undefined;

        try {
          const stream = operations.stream(sdkOptions);
          for await (const part of stream.fullStream) {
            // AI SDK's synthetic `start` precedes provider I/O. It is not a
            // provider chunk, so failures immediately after it remain pre-start.
            if (part.type !== "start") started = true;
            if (part.type === "finish-step") {
              usage = part.usage;
              providerMetadata = part.providerMetadata;
            } else if (part.type === "finish") {
              finishReason = part.finishReason;
              usage = part.totalUsage;
            }

            const events = chunkToEvents(part, request.tools, state);
            for (const event of events) yield event;

            if (part.type === "error") {
              failure = modelErrorData(part.error);
              stopReason = "error";
              break;
            }
            if (part.type === "abort") {
              failure = { message: part.reason ?? "Model request aborted", retryable: false };
              stopReason = "aborted";
              break;
            }
          }

          if (stopReason === undefined && finishReason === undefined) {
            throw new Error("Model stream ended before a finish part");
          }

          if (stopReason === undefined && finishReason !== undefined) {
            const mapped = toStopReason(finishReason);
            if (mapped === "error") {
              failure = { message: `Model stopped with finish reason: ${finishReason}`, retryable: false };
              yield { type: "error", message: failure.message, recoverable: false };
            }
          }

          if (providerMetadata !== undefined) state.message.providerMeta = providerMetadata;
          const finalStopReason = stopReason ?? (finishReason === undefined ? "error" : toStopReason(finishReason));
          completion.resolve({
            message: state.message,
            toolCalls: state.toolCalls,
            stopReason: finalStopReason,
            usage: toUsage(usage, providerMetadata),
            ...(failure === undefined ? {} : { error: failure }),
          });
        } catch (error) {
          if (!started) {
            completion.reject(error);
            throw error;
          }
          const aborted = isAbortFailure(error, request.abort);
          failure = modelErrorData(error);
          yield { type: "error", message: failure.message, recoverable: aborted ? false : failure.retryable };
          completion.resolve({
            message: state.message,
            toolCalls: state.toolCalls,
            stopReason: aborted ? "aborted" : "error",
            usage: toUsage(usage, providerMetadata),
            error: failure,
          });
        }
      },
    };
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const result = await this.#options.operations.generate(callOptions(this.#options, request));
    return { text: result.text, usage: toUsage(result.usage, result.providerMetadata) };
  }
}

export function createSdkModelPort(options: SdkModelPortOptions): ModelPort {
  return new SdkModelPort({ ...options, operations: defaultSdkOperations });
}

/** Internal golden-test seam; intentionally absent from the package barrel. */
export function createSdkModelPortWithOperations(
  options: SdkModelPortOptions,
  operations: SdkOperations,
): ModelPort {
  return new SdkModelPort({ ...options, operations });
}
