import { log } from "#/lib/logger/index.js";

/** Tracks the executions a worker is running, so a drain can report what it left behind. */
export class InFlightRuns {
  // Counted, not set membership: a redelivered task can overlap the execution
  // it replaces, and the run stays in flight until the last one settles.
  readonly #executions = new Map<string, number>();

  /** Runs `execute` while counting the run as in flight. */
  async track<T>(runId: string, execute: () => Promise<T>): Promise<T> {
    this.#executions.set(runId, (this.#executions.get(runId) ?? 0) + 1);
    try {
      return await execute();
    } finally {
      const remaining = (this.#executions.get(runId) ?? 1) - 1;
      if (remaining <= 0) this.#executions.delete(runId);
      else this.#executions.set(runId, remaining);
    }
  }

  get size(): number {
    return this.#executions.size;
  }

  /** Run ids still executing, in the order they started. */
  list(): string[] {
    return [...this.#executions.keys()];
  }
}

/** Shutdown dependencies and the grace period in-flight turns get. */
export interface DrainOptions {
  /** Stops accepting work and resolves once in-flight executions settle. */
  stop: () => Promise<void>;
  inFlight: InFlightRuns;
  /** Milliseconds to wait before abandoning the turns still running. */
  timeoutMs: number;
}

/** Whether the grace period was enough, and which runs it left uncommitted. */
export interface DrainResult {
  /** `stop-failed` means the engine's stop rejected: the worker state is unknown. */
  outcome: "drained" | "abandoned" | "stop-failed";
  abandoned: string[];
}

/**
 * Stops accepting work and waits out the current turns.
 *
 * A turn commits atomically at its end, so a turn abandoned when the grace
 * period runs out was never committed: the run's next execution replays it from
 * the last checkpoint. Waiting forever would be the worse trade.
 */
export async function drainWorker(options: DrainOptions): Promise<DrainResult> {
  let timer: NodeJS.Timeout | undefined;
  const expiry = new Promise<"abandoned">((resolve) => {
    timer = setTimeout(() => resolve("abandoned"), options.timeoutMs);
  });

  // The stop promise outlives an abandoned drain, so its failure is reported
  // here rather than left to surface as an unhandled rejection.
  const stopped = options.stop().then(
    () => "drained" as const,
    (error: unknown) => {
      log.error("Worker stop failed", { error });
      return "stop-failed" as const;
    },
  );

  try {
    const outcome = await Promise.race([stopped, expiry]);
    if (outcome === "drained") {
      log.info("Worker drained");
      return { outcome, abandoned: [] };
    }
    const abandoned = options.inFlight.list();
    log.warn(outcome === "abandoned" ? "Worker drain timed out" : "Worker stop failed", {
      timeoutMs: options.timeoutMs,
      abandonedRuns: abandoned.length,
    });
    return { outcome, abandoned };
  } finally {
    clearTimeout(timer);
  }
}
