import type { TranscriptMessage, Trigger, Usage } from "#/core/index.js";
import type { ThreadDispatchLock } from "#/dispatch/index.js";
import type { PrincipalRef } from "#/events/index.js";
import type { LoopResult } from "#/loop/index.js";
import type { ContextSession, Engine, RunRecord, RunStore } from "#/ports/index.js";

/** Metadata and optional execution task for a new run. */
export interface CreateRunInput {
  threadRef: string;
  trigger: Exclude<Trigger, "resume">;
  sessionId?: string;
  retryOfRunId?: string;
  retryAttempt?: number;
  /** Task enqueued after the run record is created. */
  execute?: () => Promise<void>;
}

/** Terminal state, usage, and session messages for a run. */
export interface FinishRunInput {
  runId: string;
  outcome: "completed" | "failed" | "cancelled";
  usage: Usage;
  errorMessage?: string;
  messages?: TranscriptMessage[];
}

/** Options for creating a retry run. */
export interface RetryRunInput {
  runId: string;
  /** Enforces the configured automatic retry limit when true. */
  automatic?: boolean;
  /** Delay in milliseconds before the retry run is created. */
  retryAfterMs?: number;
  execute?: (run: RunRecord) => Promise<void>;
}

/** Persistence, scheduling, context, locking, and policy dependencies for run lifecycle operations. */
export interface RunLifecycleOptions {
  store: RunStore;
  engine: Engine;
  context: ContextSession;
  lock: ThreadDispatchLock;
  createId: () => string;
  now: () => string;
  /** Delay implementation used for retry-after handling. */
  sleep?: (milliseconds: number) => Promise<void>;
  /**
   * Maximum automatic retries in a chain.
   * @defaultValue 2
   */
  maxAutoRetries?: number;
}

/** Signals an abort without the durable stop fact required to classify cancellation. */
export class InfrastructureAbortError extends Error {
  constructor(runId: string) {
    super(`run aborted without a stop intent: ${runId}`);
    this.name = "InfrastructureAbortError";
  }
}

class AutomaticRetryLimitError extends Error {}

/** Coordinates run records, execution, terminal state, retries, stops, and session reporting. */
export class RunLifecycle {
  readonly #options: RunLifecycleOptions;
  readonly #aborts = new Map<string, AbortController>();

  constructor(options: RunLifecycleOptions) {
    this.#options = options;
  }

  /** Creates a queued run and optionally enqueues its execution task. */
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

  /**
   * Transitions a queued or parked run to running and records its trigger.
   * A run whose row is already `running` was orphaned when its worker died:
   * a fresh execution records another start without changing state.
   */
  async start(runId: string, trigger?: Trigger): Promise<void> {
    const run = await this.#requireRun(runId);
    const event = { type: "run-started", trigger: trigger ?? run.trigger } as const;
    if (run.state === "running") {
      await this.#options.store.appendEvent(runId, event);
      return;
    }
    await this.#options.store.transitionRun({ runId, state: "running", event });
  }

  /**
   * Commits terminal state and promotes late steering to thread follow-ups.
   * It then reports messages and closes an attached context session.
   */
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

  /**
   * Starts a run, executes its loop, and finishes terminal results.
   * Paused results leave the run parked and end this execution.
   * Retryable errors create a new run until the automatic retry limit.
   * @throws {InfrastructureAbortError} When execution aborts without a recorded stop intent.
   */
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

    if (
      result.stopReason === "aborted" &&
      (await this.#options.store.getStop(runId)) === undefined
    ) {
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

  /** Records a stop intent before aborting active execution. */
  async stop(intentId: string, runId: string, by: PrincipalRef): Promise<void> {
    await this.#options.store.recordStop({
      intentId,
      runId,
      by,
      at: this.#options.now(),
    });
    this.#aborts.get(runId)?.abort();
  }

  /**
   * Creates a queued retry for a failed or stale run after any requested delay.
   * Automatic retries stop after `maxAutoRetries`; manual retries do not use that limit.
   * @throws {Error} When the source run is not failed or stale.
   */
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

  /** Reports feedback when the run has a context session. */
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
