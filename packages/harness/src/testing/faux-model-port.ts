import type { RunEventData } from "#/events/index.js";
import type {
  CompleteRequest,
  CompleteResult,
  ModelPort,
  TurnRequest,
  TurnResult,
  TurnStream,
} from "#/ports/index.js";

/** Events and final result consumed by one scripted model turn. */
export interface FauxTurnScript {
  events: readonly RunEventData[] | AsyncIterable<RunEventData>;
  result: TurnResult | Promise<TurnResult>;
}

function isAsyncIterable(
  value: readonly RunEventData[] | AsyncIterable<RunEventData>,
): value is AsyncIterable<RunEventData> {
  return Symbol.asyncIterator in value;
}

/** Deterministic model-port fake that consumes scripted turns and completions in order. */
export class FauxModelPort implements ModelPort {
  readonly turnRequests: TurnRequest[] = [];
  readonly completeRequests: CompleteRequest[] = [];
  readonly #turns: FauxTurnScript[];
  readonly #completions: Array<CompleteResult | Promise<CompleteResult>>;

  constructor(
    turns: FauxTurnScript[] = [],
    completions: Array<CompleteResult | Promise<CompleteResult>> = [],
  ) {
    this.#turns = [...turns];
    this.#completions = [...completions];
  }

  streamTurn(request: TurnRequest): TurnStream {
    const script = this.#turns.shift();
    if (script === undefined) {
      throw new Error("FauxModelPort has no scripted turn remaining");
    }
    this.turnRequests.push(request);

    return {
      result: Promise.resolve(script.result),
      async *[Symbol.asyncIterator](): AsyncIterator<RunEventData> {
        if (isAsyncIterable(script.events)) {
          yield* script.events;
          return;
        }
        yield* script.events;
      },
    };
  }

  async complete(request: CompleteRequest): Promise<CompleteResult> {
    const completion = this.#completions.shift();
    if (completion === undefined) {
      throw new Error("FauxModelPort has no scripted completion remaining");
    }
    this.completeRequests.push(request);
    return completion;
  }
}
