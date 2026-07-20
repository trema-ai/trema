import type { Engine, EngineTask } from "../ports/index.js";

/** In-memory reference engine with serial execution per thread and concurrent execution across threads. */
export class InMemoryEngine implements Engine {
  readonly #tails = new Map<string, Promise<void>>();
  readonly #pending: Promise<void>[] = [];

  /** Queues the task and returns immediately; tasks on one thread run serially. */
  async enqueue(task: EngineTask): Promise<void> {
    const previous = this.#tails.get(task.threadRef) ?? Promise.resolve();
    const current = previous.then(task.run);
    // A failed task must not block its thread's queue, but idle() still reports it.
    this.#tails.set(task.threadRef, current.catch(() => undefined));
    this.#pending.push(current);
  }

  /** Resolves when every enqueued task has settled; rejects if any task failed. */
  async idle(): Promise<void> {
    // Tasks may enqueue further tasks while we wait, so drain until stable.
    while (this.#pending.length > 0) {
      const batch = this.#pending.splice(0);
      const settled = await Promise.allSettled(batch);
      const failure = settled.find(
        (outcome): outcome is PromiseRejectedResult => outcome.status === "rejected",
      );
      if (failure !== undefined) {
        throw failure.reason instanceof Error
          ? failure.reason
          : new Error(String(failure.reason));
      }
    }
  }
}
