import type { TranscriptMessage } from "../core/index.js";
import type { PrincipalRef } from "../events/index.js";
import type { QueuedInput, RunRecord, RunStore } from "../ports/index.js";
import type { ThreadDispatchLock } from "./dispatch-lock.js";

interface IntentBase {
  intentId: string;
}

export interface MessageIntent extends IntentBase {
  type: "message" | "steer";
  threadRef: string;
  author: PrincipalRef;
  message: TranscriptMessage;
}

export interface ResolveIntent extends IntentBase {
  type: "resolve";
  threadRef: string;
  runId: string;
  elicitationId: string;
  optionId: string;
  decision: "approved" | "denied" | "answered";
  scope?: "once" | "run" | "always";
  by: PrincipalRef;
}

export interface StopIntent extends IntentBase {
  type: "stop";
  threadRef: string;
  runId: string;
  by: PrincipalRef;
}

export interface RetryIntent extends IntentBase {
  type: "retry";
  threadRef: string;
  runId: string;
  by: PrincipalRef;
}

export interface FeedbackIntent extends IntentBase {
  type: "feedback";
  threadRef: string;
  runId: string;
  value: string;
  by: PrincipalRef;
}

export type DispatchIntent =
  | MessageIntent
  | ResolveIntent
  | StopIntent
  | RetryIntent
  | FeedbackIntent;

export type DispatchResult =
  | { outcome: "duplicate" }
  | { outcome: "resolve"; runId: string }
  | { outcome: "steer"; runId: string }
  | { outcome: "new-run"; run: RunRecord }
  | { outcome: "stop"; runId: string }
  | { outcome: "retry"; run: RunRecord }
  | { outcome: "feedback"; runId: string };

export interface InputDispatcherOptions {
  store: RunStore;
  lock: ThreadDispatchLock;
  createRun(intent: MessageIntent): Promise<RunRecord>;
  resolve(intent: ResolveIntent): Promise<void>;
  stop(intent: StopIntent): Promise<void>;
  retry(intent: RetryIntent): Promise<RunRecord>;
  feedback(intent: FeedbackIntent): Promise<void>;
  classifyResolution?: (
    intent: MessageIntent,
    active: RunRecord,
  ) => Promise<ResolveIntent | undefined> | ResolveIntent | undefined;
}

export class InputDispatcher {
  readonly #options: InputDispatcherOptions;

  constructor(options: InputDispatcherOptions) {
    this.#options = options;
  }

  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    return this.#options.lock.run(intent.threadRef, async () => {
      if ((await this.#options.store.recordIntent(intent.intentId)) === "duplicate") {
        return { outcome: "duplicate" };
      }

      if (intent.type === "resolve") {
        await this.#options.resolve(intent);
        return { outcome: "resolve", runId: intent.runId };
      }
      if (intent.type === "stop") {
        await this.#options.stop(intent);
        return { outcome: "stop", runId: intent.runId };
      }
      if (intent.type === "retry") {
        return { outcome: "retry", run: await this.#options.retry(intent) };
      }
      if (intent.type === "feedback") {
        await this.#options.feedback(intent);
        return { outcome: "feedback", runId: intent.runId };
      }

      const active = await this.#options.store.findActiveRun(intent.threadRef);
      if (active !== undefined && this.#options.classifyResolution !== undefined) {
        const resolution = await this.#options.classifyResolution(intent, active);
        if (resolution !== undefined) {
          await this.#options.resolve(resolution);
          return { outcome: "resolve", runId: active.id };
        }
      }
      if (active !== undefined) {
        await this.#options.store.enqueueSteering(active.id, queuedInput(intent));
        return { outcome: "steer", runId: active.id };
      }

      return { outcome: "new-run", run: await this.#options.createRun(intent) };
    });
  }
}

function queuedInput(intent: MessageIntent): QueuedInput {
  return {
    id: intent.intentId,
    author: intent.author,
    message: intent.message,
  };
}
