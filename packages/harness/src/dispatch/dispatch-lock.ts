export class ThreadDispatchLock {
  readonly #tails = new Map<string, Promise<void>>();

  async run<T>(threadRef: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#tails.get(threadRef) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#tails.set(threadRef, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#tails.get(threadRef) === tail) this.#tails.delete(threadRef);
    }
  }
}
