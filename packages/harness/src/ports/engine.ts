/** Deferred execution associated with a run and thread. */
export interface EngineTask {
  runId: string;
  threadRef: string;
  run: () => Promise<void>;
}

/** Schedules run execution outside the caller. */
export interface Engine {
  /** Accepts a task for execution according to the engine's scheduling policy. */
  enqueue(task: EngineTask): Promise<void>;
}
