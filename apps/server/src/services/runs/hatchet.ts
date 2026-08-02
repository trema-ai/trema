import {
  ConcurrencyLimitStrategy,
  type Duration,
  type HatchetClient,
  IdempotencyCollisionError,
} from "@hatchet-dev/typescript-sdk/v1/index.js";
import type { Engine, EngineTask } from "@trema/harness";

import { log } from "#server/lib/logger/index.js";

/** The one task name a run is scheduled under. One run is one durable task. */
export const RUN_TASK_NAME = "trema-run";

/**
 * Model turns and connector calls routinely take longer than Hatchet's
 * one-minute default. Keep infrastructure retries for genuinely abandoned
 * executions instead of redelivering a healthy run while it is still writing.
 */
export const DEFAULT_RUN_EXECUTION_TIMEOUT: Duration = "30m";
export const DEFAULT_RUN_IDEMPOTENCY_FALLBACK_MS = 7 * 24 * 60 * 60 * 1_000;

/**
 * Everything the engine carries for a run.
 *
 * Only the id and the scheduling key travel: the driver loads every value a
 * decision depends on from the store, so engine variables can never go stale
 * across a retry, a redelivery, or a resume days later.
 */
export type RunTaskInput = {
  runId: string;
  /** Serializes runs per thread. The organization is part of it so tenants never share a key. */
  concurrencyKey: string;
};

/** What the engine reports back for one delivered run. */
export type RunTaskOutput = {
  status: string;
};

/** The trigger side of the run task, kept narrow so the engine is testable without Hatchet. */
export interface RunTaskTrigger {
  runNoWait(input: RunTaskInput): Promise<unknown>;
}

/** Builds the concurrency key that makes execution thread-serial. */
export function concurrencyKey(orgId: string, threadRef: string): string {
  return `${orgId}:${threadRef}`;
}

/** Timeouts and retry budget for the run task. */
export interface RunTaskOptions {
  /** How long one execution of a run may take. */
  executionTimeout?: Duration;
  /** How long a queued run waits for a slot. */
  scheduleTimeout?: Duration;
  /**
   * Infrastructure retries only. A run retry is a new run, never this number.
   * @defaultValue 3
   */
  retries?: number;
}

/**
 * Declares the run task on a Hatchet client.
 *
 * The task function is a thin driver: it forwards the run id and returns the
 * outcome as data. Harness tables are the record, so the engine only has to
 * provide liveness, thread-serial concurrency, and retries of infrastructure
 * failures.
 */
export function defineRunTask(
  hatchet: HatchetClient,
  execute: (runId: string) => Promise<{ status: string }>,
  options: RunTaskOptions = {},
) {
  return hatchet.task<RunTaskInput, RunTaskOutput>({
    name: RUN_TASK_NAME,
    idempotency: {
      strategy: "status",
      expression: "input.runId",
      fallbackTtlMs: DEFAULT_RUN_IDEMPOTENCY_FALLBACK_MS,
    },
    concurrency: {
      expression: "input.concurrencyKey",
      maxRuns: 1,
      // Queue the next run on the thread; cancelling it would discard work the
      // harness already committed.
      limitStrategy: ConcurrencyLimitStrategy.GROUP_ROUND_ROBIN,
    },
    retries: options.retries ?? 3,
    executionTimeout: options.executionTimeout ?? DEFAULT_RUN_EXECUTION_TIMEOUT,
    ...(options.scheduleTimeout === undefined ? {} : { scheduleTimeout: options.scheduleTimeout }),
    fn: async (input: RunTaskInput): Promise<RunTaskOutput> => execute(input.runId),
  });
}

/**
 * Builds the per-organization engine the API process schedules runs through.
 *
 * The task is declared for its trigger only: this process registers no worker,
 * so the stub function never runs. Execution happens wherever `trema worker`
 * is running against the same Hatchet.
 */
export function createRunEngineFactory(hatchet: HatchetClient): (orgId: string) => Engine {
  const task = defineRunTask(hatchet, async (runId) => {
    throw new Error(`the API process does not execute runs: ${runId}`);
  });
  const engines = new Map<string, HatchetEngine>();
  return (orgId) => {
    const existing = engines.get(orgId);
    if (existing !== undefined) return existing;
    const engine = new HatchetEngine({ trigger: task, orgId });
    engines.set(orgId, engine);
    return engine;
  };
}

/** Scheduling dependencies for the Hatchet engine. */
export interface HatchetEngineOptions {
  trigger: RunTaskTrigger;
  orgId: string;
}

/**
 * The `Engine` port on Hatchet.
 *
 * `EngineTask.run` is ignored by design: a closure cannot survive a process,
 * and the workflow function rebuilds the execution from the run id instead. A
 * resume re-enqueues the same run, so no second row exists for it.
 */
export class HatchetEngine implements Engine {
  readonly #trigger: RunTaskTrigger;
  readonly #orgId: string;

  constructor(options: HatchetEngineOptions) {
    this.#trigger = options.trigger;
    this.#orgId = options.orgId;
  }

  async enqueue(task: EngineTask): Promise<void> {
    try {
      await this.#trigger.runNoWait({
        runId: task.runId,
        concurrencyKey: concurrencyKey(this.#orgId, task.threadRef),
      });
    } catch (error) {
      if (!(error instanceof IdempotencyCollisionError)) throw error;
      log.debug("Run was already enqueued", { runId: task.runId, threadRef: task.threadRef });
      return;
    }
    log.debug("Run enqueued", { runId: task.runId, threadRef: task.threadRef });
  }
}
