import { HatchetClient, type Worker } from "@hatchet-dev/typescript-sdk/v1/index.js";

import { createPrismaClient, type Database } from "#/lib/db/index.js";
import type { Environment } from "#/lib/env/schema.js";
import { configureLogger, log } from "#/lib/logger/index.js";
import {
  createRunServices,
  defineRunTask,
  drainWorker,
  HatchetEngine,
  InFlightRuns,
  RUN_TASK_NAME,
  type RunDriverResult,
  resolveConfiguredModel,
} from "#/services/runs/index.js";

export interface RunWorkerDependencies {
  env: Environment;
  /** Overrides the Hatchet client, which lets a local run point at a test engine. */
  hatchet?: HatchetClient;
}

/** The started worker and the pieces a caller needs to stop it. */
export interface RunWorker {
  worker: Worker;
  db: Database;
  inFlight: InFlightRuns;
  /** Stops accepting work, waits out the current turns, and releases the database. */
  shutdown(): Promise<void>;
}

/**
 * Runs one delivered run.
 *
 * The organization comes from the run row rather than from the task input, so
 * nothing a decision depends on travels through the engine.
 */
async function executeDeliveredRun(
  db: Database,
  env: Environment,
  engineFor: (orgId: string) => HatchetEngine,
  runId: string,
): Promise<RunDriverResult> {
  const row = await db.agentRun.findUnique({ where: { id: runId }, select: { orgId: true } });
  if (row === null) {
    log.warn("Run execution skipped", { runId, reason: "unknown_run" });
    return { status: "unknown" };
  }
  const { modelPort, model } = resolveConfiguredModel(env);
  const services = createRunServices({
    db,
    env,
    orgId: row.orgId,
    engine: engineFor(row.orgId),
    modelPort,
    model,
  });
  if (services.driver === undefined) {
    throw new Error("The worker composed no run driver");
  }
  return services.driver.execute(runId);
}

/**
 * Starts the run worker.
 *
 * One run is one durable task, keyed for concurrency by its thread so execution
 * is thread-serial by construction. The task function is a thin driver: it
 * carries a run id, and the harness tables carry the record.
 */
export async function startRunWorker({
  env,
  hatchet: provided,
}: RunWorkerDependencies): Promise<RunWorker> {
  configureLogger(env);
  // Fail before the worker registers if the deployment cannot call a model.
  resolveConfiguredModel(env);

  const db = createPrismaClient(env.DATABASE_URL);
  const hatchet = provided ?? HatchetClient.init();
  const inFlight = new InFlightRuns();

  const engines = new Map<string, HatchetEngine>();
  let task: ReturnType<typeof defineRunTask> | undefined;
  const engineFor = (orgId: string): HatchetEngine => {
    const existing = engines.get(orgId);
    if (existing !== undefined) return existing;
    if (task === undefined) throw new Error("The run task is not declared yet");
    const engine = new HatchetEngine({ trigger: task, orgId });
    engines.set(orgId, engine);
    return engine;
  };

  task = defineRunTask(hatchet, async (runId) =>
    inFlight.track(runId, async () => {
      const result = await executeDeliveredRun(db, env, engineFor, runId);
      return { status: result.status };
    }),
  );

  const worker = await hatchet.worker(env.TREMA_WORKER_NAME, {
    slots: env.TREMA_WORKER_SLOTS,
    // The drain below owns shutdown, so the SDK must not race it.
    handleKill: false,
  });
  await worker.registerWorkflows([task]);

  const shutdown = async (): Promise<void> => {
    const result = await drainWorker({
      stop: () => worker.stop(),
      inFlight,
      timeoutMs: env.TREMA_WORKER_DRAIN_TIMEOUT_MS,
    });
    if (result.outcome !== "drained") {
      // The pool stays open until the process exits: closing it now would fail
      // the very commits that decide each abandoned run's fate. A turn that
      // still commits is a valid checkpoint the next execution reads; one that
      // does not was never committed and replays.
      log.warn("Runs still executing at shutdown", {
        outcome: result.outcome,
        runIds: result.abandoned,
      });
      return;
    }
    await db.$disconnect();
  };

  log.info("Run worker starting", {
    worker: env.TREMA_WORKER_NAME,
    task: RUN_TASK_NAME,
    slots: env.TREMA_WORKER_SLOTS,
  });
  void worker.start();
  return { worker, db, inFlight, shutdown };
}

/** Starts the worker and drains it on the first termination signal. */
export async function serveRunWorker(dependencies: RunWorkerDependencies): Promise<RunWorker> {
  const started = await startRunWorker(dependencies);
  let stopping = false;
  const onSignal = (signal: NodeJS.Signals): void => {
    if (stopping) return;
    stopping = true;
    log.info("Draining run worker", { signal });
    void started
      .shutdown()
      .then(
        () => log.info("Run worker stopped", { signal }),
        (error: unknown) => {
          log.error("Run worker shutdown failed", { error });
          process.exitCode = 1;
        },
      )
      // The drain already waited as long as the deployment allows; an exit is
      // what actually ends an execution the grace period could not.
      .finally(() => process.exit(process.exitCode ?? 0));
  };
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  return started;
}
