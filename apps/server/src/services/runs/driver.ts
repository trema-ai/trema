import type {
  HarnessHooks,
  LoopResult,
  ModelPort,
  ModelRef,
  RunLifecycle,
  RunRecord,
  RunState,
  RunStore,
  SessionStanding,
  ThinkingLevel,
  ToolDef,
  ToolExecutor,
  TranscriptMessage,
  Trigger,
} from "@trema/harness";
import { runLoop } from "@trema/harness";

import { log } from "#server/lib/logger/index.js";

/** Run states that end the run for good, so a delivered task has nothing to do. */
const TERMINAL_RUN_STATES: RunState[] = ["completed", "failed", "cancelled", "stale"];

const PARKED_RUN_STATES: RunState[] = ["awaiting_approval", "awaiting_input"];

const NO_USAGE = {
  inputTokens: 0,
  outputTokens: 0,
  totalTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  costUsd: 0,
};

/**
 * What one execution needs beyond the run's own committed rows: the model to
 * call and the session-resolved context to call it with.
 */
export interface RunExecutionPlan {
  model: ModelRef;
  /**
   * The port that reaches that model. It is planned rather than injected
   * because model configuration is per-organization control-plane data that can
   * be missing or unusable — which is a fact about the run, recorded on it.
   */
  modelPort: ModelPort;
  standing: SessionStanding;
  tools: ToolDef[];
  /** Messages already on the thread before this run's first turn. */
  threadMessages: TranscriptMessage[];
  thinking?: ThinkingLevel;
  maxTurns?: number;
  /** Standard date-time string after which a blocking elicitation expires. */
  elicitationExpiresAt?: string;
  hooks?: HarnessHooks;
}

/** A run that cannot start. The failure is recorded on the run, not thrown at the engine. */
export class RunNotStartableError extends Error {
  constructor(
    readonly runId: string,
    message: string,
  ) {
    super(message);
    this.name = "RunNotStartableError";
  }
}

/** Persistence, model, tool, and planning dependencies for the run driver. */
export interface RunDriverOptions {
  store: RunStore;
  lifecycle: RunLifecycle;
  toolExecutor: ToolExecutor;
  /** Resolves the session-derived inputs for one execution. */
  plan: (run: RunRecord) => Promise<RunExecutionPlan>;
}

/** Outcome of one delivered execution, reported to the engine as data. */
export type RunDriverResult =
  | { status: "unknown" }
  | { status: "skipped"; state: RunState }
  | { status: "start-failed"; error: string }
  | { status: "paused"; result: LoopResult }
  | { status: "finished"; result: LoopResult };

/** Executes one delivered run from the store. */
export interface RunDriver {
  execute(runId: string): Promise<RunDriverResult>;
}

function executionTrigger(run: RunRecord): Trigger {
  return PARKED_RUN_STATES.includes(run.state) ? "resume" : run.trigger;
}

/**
 * Builds the driver the workflow engine invokes.
 *
 * The engine hands over a run id and nothing else: the driver reads the run,
 * its committed turns, and its queues from the store, so a redelivered task, a
 * resume, or a retry can never act on values the engine happened to carry.
 */
export function createRunDriver(options: RunDriverOptions): RunDriver {
  async function failToStart(run: RunRecord, trigger: Trigger, error: string): Promise<void> {
    await options.lifecycle.start(run.id, trigger);
    await options.store.appendEvent(run.id, { type: "error", message: error, recoverable: false });
    await options.lifecycle.finish({
      runId: run.id,
      outcome: "failed",
      usage: NO_USAGE,
      errorMessage: error,
    });
  }

  return {
    async execute(runId: string): Promise<RunDriverResult> {
      const run = await options.store.getRun(runId);
      if (run === undefined) {
        log.warn("Run execution skipped", { runId, reason: "unknown_run" });
        return { status: "unknown" };
      }
      if (TERMINAL_RUN_STATES.includes(run.state)) {
        log.info("Run execution skipped", { runId, reason: "terminal_state", state: run.state });
        return { status: "skipped", state: run.state };
      }

      const trigger = executionTrigger(run);
      let plan: RunExecutionPlan;
      try {
        plan = await options.plan(run);
      } catch (error) {
        // A run that cannot start fails loudly on the run itself: an
        // unresolvable session is product surface, not a worker crash.
        const message = error instanceof Error ? error.message : String(error);
        log.warn("Run could not start", { runId, error: message });
        await failToStart(run, trigger, message);
        return { status: "start-failed", error: message };
      }

      const result = await options.lifecycle.execute(
        runId,
        (abort) =>
          runLoop({
            runId,
            threadRef: run.threadRef,
            model: plan.model,
            standing: plan.standing,
            threadMessages: plan.threadMessages,
            tools: plan.tools,
            modelPort: plan.modelPort,
            store: options.store,
            toolExecutor: options.toolExecutor,
            abort,
            ...(plan.thinking === undefined ? {} : { thinking: plan.thinking }),
            ...(plan.maxTurns === undefined ? {} : { maxTurns: plan.maxTurns }),
            ...(plan.elicitationExpiresAt === undefined
              ? {}
              : { elicitationExpiresAt: plan.elicitationExpiresAt }),
            ...(plan.hooks === undefined ? {} : { hooks: plan.hooks }),
          }),
        undefined,
        trigger,
      );

      if (result.status === "paused") {
        log.info("Run parked", { runId, elicitationId: result.elicitation.elicitationId });
        return { status: "paused", result };
      }
      log.info("Run finished", { runId, outcome: result.outcome, turns: result.turns });
      return { status: "finished", result };
    },
  };
}
