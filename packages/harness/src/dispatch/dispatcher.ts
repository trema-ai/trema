import type { TranscriptMessage } from "#harness/core/index.js";
import type { PrincipalRef } from "#harness/events/index.js";
import type { IntentClaimMeta, QueuedInput, RunRecord, RunStore } from "#harness/ports/index.js";
import type { ThreadDispatchLock } from "./dispatch-lock.js";

interface IntentBase {
  intentId: string;
}

/** New user input or an explicit steering request for a thread. */
export interface MessageIntent extends IntentBase {
  type: "message" | "steer";
  threadRef: string;
  author: PrincipalRef;
  message: TranscriptMessage;
}

/** Decision that resolves a run's blocking elicitation. */
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

/** Request to stop an active run. */
export interface StopIntent extends IntentBase {
  type: "stop";
  threadRef: string;
  runId: string;
  by: PrincipalRef;
}

/** Request to retry a failed or stale run. */
export interface RetryIntent extends IntentBase {
  type: "retry";
  threadRef: string;
  runId: string;
  by: PrincipalRef;
}

/** Feedback associated with a run. */
export interface FeedbackIntent extends IntentBase {
  type: "feedback";
  threadRef: string;
  runId: string;
  value: string;
  by: PrincipalRef;
}

/** Intent accepted by the input dispatcher. */
export type DispatchIntent =
  | MessageIntent
  | ResolveIntent
  | StopIntent
  | RetryIntent
  | FeedbackIntent;

/** Routing decision or delegated operation completed by dispatch. */
export type DispatchResult =
  | { outcome: "duplicate" }
  | { outcome: "resolve"; runId: string }
  | { outcome: "steer"; runId: string }
  | { outcome: "new-run"; run: RunRecord }
  | { outcome: "stop"; runId: string }
  | { outcome: "retry"; run: RunRecord }
  | { outcome: "feedback"; runId: string };

/** Persistence, locking, and delegated operations used during dispatch. */
export interface InputDispatcherOptions {
  store: RunStore;
  lock: ThreadDispatchLock;
  createRun(intent: MessageIntent): Promise<RunRecord>;
  resolve(intent: ResolveIntent): Promise<void>;
  stop(intent: StopIntent): Promise<void>;
  retry(intent: RetryIntent): Promise<RunRecord>;
  feedback(intent: FeedbackIntent): Promise<void>;
  /** Optionally interprets a message as a response to an active elicitation. */
  classifyResolution?: (
    intent: MessageIntent,
    active: RunRecord,
  ) => Promise<ResolveIntent | undefined> | ResolveIntent | undefined;
}

/** Routes idempotent intents while serializing decisions for each thread. */
export class InputDispatcher {
  readonly #options: InputDispatcherOptions;

  constructor(options: InputDispatcherOptions) {
    this.#options = options;
  }

  /**
   * Claims `intentId` once, then routes the intent under the thread lock.
   * A message steers the active run or creates a run when none is active.
   * Resolution classification takes precedence over steering.
   */
  async dispatch(intent: DispatchIntent): Promise<DispatchResult> {
    return this.#options.lock.run(intent.threadRef, async () => {
      if (
        (await this.#options.store.recordIntent(intent.intentId, claimMeta(intent))) === "duplicate"
      ) {
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

/** The claim's fingerprint: what a later reuse of the id is checked against. */
function claimMeta(intent: DispatchIntent): IntentClaimMeta {
  if (intent.type === "resolve") return { kind: "resolve", targetId: intent.elicitationId };
  if (intent.type === "stop" || intent.type === "retry" || intent.type === "feedback") {
    return { kind: intent.type, targetId: intent.runId };
  }
  return { kind: intent.type };
}

function queuedInput(intent: MessageIntent): QueuedInput {
  return {
    id: intent.intentId,
    author: intent.author,
    message: intent.message,
  };
}
