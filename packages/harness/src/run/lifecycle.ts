import type { TranscriptMessage, Trigger, Usage } from "../core/index.js";
import type { LoopResult } from "../loop/index.js";
import type { ContextSession, Engine, RunRecord, RunStore } from "../ports/index.js";
import type { ThreadDispatchLock } from "../dispatch/index.js";

export interface CreateRunInput {
  threadRef: string;
  trigger: Exclude<Trigger, "resume">;
  sessionId?: string;
  retryOfRunId?: string;
  retryAttempt?: number;
  execute?: () => Promise<void>;
}

export interface FinishRunInput {
  runId: string;
  outcome: "completed" | "failed" | "cancelled";
  usage: Usage;
  errorMessage?: string;
  messages?: TranscriptMessage[];
}

export interface RetryRunInput {
  runId: string;
  automatic?: boolean;
  retryAfterMs?: number;
  execute?: (run: RunRecord) => Promise<void>;
}

export interface RunLifecycleOptions {
  store: RunStore;
  engine: Engine;
  context: ContextSession;
  lock: ThreadDispatchLock;
  createId: () => string;
  now: () => string;
  sleep?: (milliseconds: number) => Promise<void>;
  maxAutoRetries?: number;
}

export class InfrastructureAbortError extends Error {
  constructor(runId: string) {
    super(`run aborted without a stop intent: ${runId}`);
    this.name = "InfrastructureAbortError";
  }
}

class AutomaticRetryLimitError extends Error {}

export class RunLifecycle {
  readonly #options: RunLifecycleOptions;
  readonly #aborts = new Map<string, AbortController>();

  constructor(options: RunLifecycleOptions) {
    this.#options = options;
  }

  async create(input: CreateRunInput): Promise<RunRecord> {
    const run: RunRecord = {
      id: this.#options.createId(),
      threadRef: input.threadRef,
      state: "queued",
      trigger: input.trigger,
      turnCount: 0,
      ...(input.sessionId === undefined ? {} : { sessionId: input.sessionId }),
      ...(input.retryOfRunId === undefined ? {} : { retryOfRunId: input.retryOfRunId }),
      ...(input.retryAttempt === undefined ? {} : { retryAttempt: input.retryAttempt }),
    };
    await this.#options.store.createRun(run);
    if (input.execute !== undefined) await this.#enqueue(run, input.execute);
    return run;
  }

  async start(runId: string, trigger?: Trigger): Promise<void> {
    const run = await this.#requireRun(runId);
    await this.#options.store.transitionRun({
      runId,
      state: "running",
      event: { type: "run-started", trigger: trigger ?? run.trigger },
    });
  }

  async finish(input: FinishRunInput): Promise<void> {
    const run = await this.#requireRun(input.runId);
    await this.#options.lock.run(run.threadRef, async () => {
      const lateSteering = await this.#options.store.drainSteering(run.id);
      for (const queued of lateSteering) {
        await this.#options.store.enqueueFollowUp(run.threadRef, queued);
      }
      await this.#options.store.transitionRun({
        runId: run.id,
        state: outcomeState(input.outcome),
        event: {
          type: "run-finished",
          outcome: input.outcome,
          usage: input.usage,
          ...(input.errorMessage === undefined ? {} : { errorMessage: input.errorMessage }),
        },
        usage: input.usage,
        ...(input.errorMessage === undefined ? {} : { error: input.errorMessage }),
      });
    });

    if (run.sessionId !== undefined) {
      if (input.messages !== undefined && input.messages.length > 0) {
        await this.#options.context.reportMessages(run.sessionId, input.messages);
      }
      await this.#options.context.close(run.sessionId, input.usage);
    }
    this.#aborts.delete(run.id);
  }

  async execute(
    runId: string,
    loop: (abort: AbortSignal, runId: string) => Promise<LoopResult>,
    messages?: TranscriptMessage[],
    trigger?: Trigger,
  ): Promise<LoopResult> {
    const controller = new AbortController();
    this.#aborts.set(runId, controller);
    await this.start(runId, trigger);
    const result = await loop(controller.signal, runId);
    if (result.status === "paused") {
      const run = await this.#requireRun(runId);
      if (run.state === "running") {
        await this.#options.store.updateRunState(
          runId,
          result.elicitation.kind === "approval" ? "awaiting_approval" : "awaiting_input",
        );
      }
      this.#aborts.delete(runId);
      return result;
    }

    if (result.stopReason === "aborted" && (await this.#options.store.getStop(runId)) === undefined) {
      this.#aborts.delete(runId);
      throw new InfrastructureAbortError(runId);
    }
    await this.finish({
      runId,
      outcome: result.outcome,
      usage: result.usage,
      ...(result.error === undefined ? {} : { errorMessage: result.error.message }),
      ...(messages === undefined ? {} : { messages }),
    });
    if (result.error?.retryable === true) {
      try {
        await this.retry({
          runId,
          automatic: true,
          ...(result.error.retryAfterMs === undefined
            ? {}
            : { retryAfterMs: result.error.retryAfterMs }),
          execute: async (retryRun) => {
            await this.execute(retryRun.id, loop, messages);
          },
        });
      } catch (error) {
        if (!(error instanceof AutomaticRetryLimitError)) throw error;
      }
    }
    return result;
  }

  async stop(intentId: string, runId: string, by: { principalId: string; displayName?: string }): Promise<void> {
    await this.#options.store.recordStop({
      intentId,
      runId,
      by,
      at: this.#options.now(),
    });
    this.#aborts.get(runId)?.abort();
  }

  async retry(input: RetryRunInput): Promise<RunRecord> {
    const failed = await this.#requireRun(input.runId);
    if (!["failed", "stale"].includes(failed.state)) {
      throw new Error(`run is not retryable: ${input.runId}`);
    }
    const attempt = (failed.retryAttempt ?? 0) + 1;
    if (input.automatic === true && attempt > (this.#options.maxAutoRetries ?? 2)) {
      throw new AutomaticRetryLimitError(`automatic retry limit reached: ${input.runId}`);
    }
    const delay = input.retryAfterMs ?? 0;
    await this.#options.store.appendEvent(failed.id, {
      type: "data",
      name: "run-retry",
      data: { automatic: input.automatic === true, attempt, retryAfterMs: delay },
    });
    if (delay > 0) await (this.#options.sleep ?? defaultSleep)(delay);
    const retry = await this.create({
      threadRef: failed.threadRef,
      trigger: "retry",
      retryOfRunId: failed.id,
      retryAttempt: attempt,
      ...(failed.sessionId === undefined ? {} : { sessionId: failed.sessionId }),
    });
    if (input.execute !== undefined) {
      await this.#enqueue(retry, () => input.execute!(retry));
    }
    return retry;
  }

  async feedback(runId: string, value: string): Promise<void> {
    const run = await this.#requireRun(runId);
    if (run.sessionId !== undefined) {
      await this.#options.context.reportFeedback(run.sessionId, run.id, value);
    }
  }

  async #enqueue(run: RunRecord, execute: () => Promise<void>): Promise<void> {
    await this.#options.engine.enqueue({ runId: run.id, threadRef: run.threadRef, run: execute });
  }

  async #requireRun(runId: string): Promise<RunRecord> {
    const run = await this.#options.store.getRun(runId);
    if (run === undefined) throw new Error(`unknown run: ${runId}`);
    return run;
  }
}

function outcomeState(outcome: FinishRunInput["outcome"]): "completed" | "failed" | "cancelled" {
  return outcome;
}

function defaultSleep(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
