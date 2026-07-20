export interface EngineTask {
  runId: string;
  threadRef: string;
  run: () => Promise<void>;
}

export interface Engine {
  enqueue(task: EngineTask): Promise<void>;
}
