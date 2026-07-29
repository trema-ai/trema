import { randomUUID } from "node:crypto";

import type {
  Clock,
  ContextSession,
  Engine,
  PrincipalRef,
  RunRecord,
  RunStore,
  ToolExecutor,
} from "@trema/harness";
import { InterruptManager, RunLifecycle, ThreadDispatchLock } from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";
import { createRunCapture } from "#server/services/runs/capture.js";
import { ServerContextSession } from "#server/services/runs/context.js";
import { createRunDriver, type RunDriver } from "#server/services/runs/driver.js";
import type { ConfiguredModel } from "#server/services/runs/models.js";
import { withToolOutputRefs } from "#server/services/runs/outputs.js";
import { createSessionRunPlan } from "#server/services/runs/plan.js";
import { PrismaRunStore } from "#server/services/runs/store.js";

export type {
  ResolveRunAccessOptions,
  ResolveRunsAccessOptions,
  RunAccess,
  RunAccessLevel,
} from "./access.js";
export { resolveRunAccess, resolveRunsAccess } from "./access.js";
export type { CaptureOpeningMessages, QueuedMessage, RunCaptureOptions } from "./capture.js";
export { createRunCapture, openingMessages } from "./capture.js";
export { ContextCapabilityUnavailableError, ServerContextSession } from "./context.js";
export type { DrainOptions, DrainResult } from "./drain.js";
export { drainWorker, InFlightRuns } from "./drain.js";
export type { RunDriver, RunDriverResult, RunExecutionPlan } from "./driver.js";
export { createRunDriver, RunNotStartableError } from "./driver.js";
export type { RunTaskInput, RunTaskOptions, RunTaskOutput, RunTaskTrigger } from "./hatchet.js";
export {
  concurrencyKey,
  createRunEngineFactory,
  defineRunTask,
  HatchetEngine,
  RUN_TASK_NAME,
} from "./hatchet.js";
export type { OpeningMessage, ThreadHistoryOptions, ThreadRunLog } from "./history.js";
export {
  DEFAULT_THREAD_HISTORY_RUNS,
  deriveOpeningMessage,
  deriveRunMessages,
  deriveThreadMessages,
  readThreadMessages,
} from "./history.js";
export type { ConfiguredModel, ResolveConfiguredModelOptions } from "./models.js";
export { ModelConfigurationError, resolveConfiguredModel } from "./models.js";
export type { RenderedOutputBlock } from "./outputs.js";
export {
  renderToolOutputBlocks,
  TOOL_OUTPUT_IMAGE_BYTE_CAP,
  TOOL_OUTPUT_TEXT_BYTE_CAP,
  withToolOutputRefs,
} from "./outputs.js";
export type { SessionRunPlanOptions } from "./plan.js";
export { createSessionRunPlan, narrowTools } from "./plan.js";
export type { PrismaRunStoreOptions } from "./store.js";
export { PrismaRunStore } from "./store.js";
export type {
  StartRunInput,
  StartRunOptions,
  StartRunResult,
  SubmitTargetIntentInput,
  SubmitTargetIntentOptions,
  TargetIntent,
  TargetIntentResult,
} from "./trigger.js";
export {
  IntentMismatchError,
  IntentOptionError,
  IntentStateError,
  IntentTargetError,
  startRun,
  submitTargetIntent,
} from "./trigger.js";

/**
 * One dispatch lock per process.
 *
 * Classification for a thread has to happen one decision at a time, and the
 * server profile runs dispatch in one process per deployment.
 */
export const threadDispatchLock = new ThreadDispatchLock();

/** A tool call the deployment cannot execute yet. Failures are results, never throws. */
export function createUnavailableToolExecutor(): ToolExecutor {
  return {
    async execute(call) {
      return {
        callId: call.callId,
        status: "error",
        summary: `Tool '${call.name}' is not available in this deployment`,
        output: `Tool '${call.name}' is not available in this deployment`,
      };
    },
  };
}

/** Dependencies for one organization's run services. */
export interface RunServicesOptions {
  db: Database;
  env: Environment;
  orgId: string;
  engine: Engine;
  /** Required to execute runs. The API process only creates and routes them. */
  resolveModel?: () => Promise<ConfiguredModel>;
  toolExecutor?: ToolExecutor;
  /** Builds a connector-capable executor from the pinned session each run opens. */
  toolExecutorForSession?: (session: DataPlaneSession) => ToolExecutor;
  context?: ContextSession;
  clock?: Clock;
  createId?: () => string;
  /** Principal recorded when an elicitation expires. */
  expiryPrincipal?: PrincipalRef;
}

/** The ports and coordinators one organization's runs are executed through. */
export interface RunServices {
  orgId: string;
  db: Database;
  store: RunStore;
  context: ContextSession;
  engine: Engine;
  lifecycle: RunLifecycle;
  interrupts: InterruptManager;
  /** Present only where a model is configured, which is the worker process. */
  driver: RunDriver | undefined;
  lock: ThreadDispatchLock;
  /** Enqueues fresh execution for a run without creating a second row. */
  enqueue(run: RunRecord): Promise<void>;
}

/**
 * Composes the real ports for one organization.
 *
 * The same wiring serves the API process and the worker process. Only the
 * `Engine` differs in what it does with an enqueue: Hatchet schedules a durable
 * task, while the in-memory engine runs the driver in process.
 */
export function createRunServices(options: RunServicesOptions): RunServices {
  const clock: Clock = options.clock ?? { now: () => new Date().toISOString() };
  const createId = options.createId ?? randomUUID;
  const store = new PrismaRunStore({ db: options.db, orgId: options.orgId, clock });
  const context =
    options.context ??
    new ServerContextSession({
      db: options.db,
      orgId: options.orgId,
      standingBudgetTokens: options.env.TREMA_SESSION_STANDING_BUDGET_TOKENS,
    });

  // The driver is built after the lifecycle it uses, so the enqueued closure
  // reads it lazily. Hatchet ignores the closure and reloads from the run id.
  let driver: RunDriver | undefined;
  const enqueue = async (run: RunRecord): Promise<void> => {
    await options.engine.enqueue({
      runId: run.id,
      threadRef: run.threadRef,
      run: async () => {
        await driver?.execute(run.id);
      },
    });
  };

  const lifecycle = new RunLifecycle({
    store,
    engine: options.engine,
    context,
    lock: threadDispatchLock,
    createId,
    now: () => clock.now(),
  });
  const interrupts = new InterruptManager({
    store,
    context,
    now: () => clock.now(),
    // Thread participation is a context-app question; until it answers one,
    // possession of a credential for this organization is the check.
    isParticipant: () => true,
    enqueueResume: enqueue,
    ...(options.expiryPrincipal === undefined ? {} : { expiryPrincipal: options.expiryPrincipal }),
  });

  if (options.resolveModel !== undefined) {
    const resolveModel = options.resolveModel;
    const toolExecutorForSession = options.toolExecutorForSession;
    driver = createRunDriver({
      store,
      lifecycle,
      // Every executor is wrapped so results carrying a body are addressable:
      // the ref is what the run view's lazy output expansion fetches by.
      toolExecutor: withToolOutputRefs(options.toolExecutor ?? createUnavailableToolExecutor()),
      capture: createRunCapture({ db: options.db, orgId: options.orgId }),
      plan: createSessionRunPlan({
        db: options.db,
        orgId: options.orgId,
        resolveModel,
        maxTurns: options.env.TREMA_RUN_MAX_TURNS,
        elicitationTtlMs: options.env.TREMA_ELICITATION_TTL_MS,
        ...(toolExecutorForSession === undefined
          ? {}
          : {
              toolExecutorForSession: (session) =>
                withToolOutputRefs(toolExecutorForSession(session)),
            }),
      }),
    });
  }

  return {
    orgId: options.orgId,
    db: options.db,
    store,
    context,
    engine: options.engine,
    lifecycle,
    interrupts,
    driver,
    lock: threadDispatchLock,
    enqueue,
  };
}
