import { log } from "#/lib/logger/index.js";

/** Tracks the executions a worker is running, so a drain can report what it left behind. */
export class InFlightRuns {
  readonly #runIds = new Set<string>();

  /** Runs `execute` while counting the run as in flight. */
  async track<T>(runId: string, execute: () => Promise<T>): Promise<T> {
    this.#runIds.add(runId);
    try {
      return await execute();
    } finally {
      this.#runIds.delete(runId);
    }
  }

  get size(): number {
    return this.#runIds.size;
  }

  /** Run ids still executing, in the order they started. */
  list(): string[] {
    return [...this.#runIds];
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
  outcome: "drained" | "abandoned";
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
      return "drained" as const;
    },
  );

  try {
    const outcome = await Promise.race([stopped, expiry]);
    if (outcome === "drained") {
      log.info("Worker drained");
      return { outcome, abandoned: [] };
    }
    const abandoned = options.inFlight.list();
    log.warn("Worker drain timed out", {
      timeoutMs: options.timeoutMs,
      abandonedRuns: abandoned.length,
    });
    return { outcome, abandoned };
  } finally {
    clearTimeout(timer);
  }
}
