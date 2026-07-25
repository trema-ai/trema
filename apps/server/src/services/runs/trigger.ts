import type { MessageIntent, PrincipalRef, RunRecord, TranscriptMessage } from "@trema/harness";
import { InputDispatcher } from "@trema/harness";

import { log } from "#/lib/logger/index.js";
import type { RunServices } from "#/services/runs/index.js";

/** Where a run comes from, beyond the message itself. */
export interface RunOrigin {
  /** Every trigger enters the same dispatch; `resume` re-enqueues instead of creating a run. */
  trigger: "message" | "api" | "schedule";
  surface: string;
  locationRef: string;
  /**
   * The person who asked. Scheduled work names the principal who activated the
   * schedule. Omit it when nobody did, such as a service call as the agent.
   */
  requester?: { principalId: string } | { externalUserId: string };
  /** Narrows the session's resolved tools. It can never widen them. */
  toolAllowlist?: string[];
}

/** One request to start work on a thread. */
export interface StartRunInput extends RunOrigin {
  /** Plays `intentId`'s role: at-least-once callers, exactly-once runs. */
  idempotencyKey: string;
  /** Defaults to the surface and location, so one location is one thread. */
  threadRef?: string;
  message: TranscriptMessage;
  author: PrincipalRef;
}

/** Where the message landed. The caller never waits for execution. */
export interface StartRunResult {
  outcome: "started" | "steered" | "duplicate";
  /** The run the message landed on, or `null` for a duplicate still being routed. */
  runId: string | null;
  threadRef: string;
}

/** Services plus the request they act on. */
export interface StartRunOptions {
  services: RunServices;
  input: StartRunInput;
}

function threadRefFor(input: StartRunInput): string {
  return input.threadRef ?? `${input.surface}:${input.locationRef}`;
}

function buildDispatcher(services: RunServices, input: StartRunInput): InputDispatcher {
  const createRun = async (intent: MessageIntent): Promise<RunRecord> => {
    const snapshot = await services.context.open({
      surface: input.surface,
      locationRef: input.locationRef,
      ...(input.requester === undefined ? {} : { requester: input.requester }),
    });
    const run = await services.lifecycle.create({
      threadRef: intent.threadRef,
      trigger: input.trigger,
      sessionId: snapshot.sessionId,
    });
    if (input.toolAllowlist !== undefined && input.toolAllowlist.length > 0) {
      await services.db.agentRun.update({
        where: { id: run.id },
        data: { toolAllowlist: input.toolAllowlist },
      });
    }
    // The opening message is queued before the run is enqueued, so an execution
    // can never dequeue a run whose first message has not landed.
    await services.store.enqueueSteering(run.id, {
      id: intent.intentId,
      author: intent.author,
      message: intent.message,
    });
    await services.enqueue(run);
    return run;
  };

  return new InputDispatcher({
    store: services.store,
    lock: services.lock,
    createRun,
    resolve: async (intent) => {
      await services.interrupts.resolve({
        elicitationId: intent.elicitationId,
        optionId: intent.optionId,
        decision: intent.decision,
        by: intent.by,
        ...(intent.scope === undefined ? {} : { scope: intent.scope }),
      });
    },
    stop: async (intent) => {
      await services.lifecycle.stop(intent.intentId, intent.runId, intent.by);
    },
    retry: async (intent) =>
      services.lifecycle.retry({ runId: intent.runId, execute: services.enqueue }),
    feedback: async (intent) => {
      await services.lifecycle.feedback(intent.runId, intent.value);
    },
  });
}

/**
 * Enters a message into the same per-thread dispatch every trigger uses.
 *
 * An active run absorbs the message as steering; otherwise a new run starts.
 * The result reports where the message landed and nothing about execution: a
 * caller observes progress through the run's event stream.
 */
export async function startRun({ services, input }: StartRunOptions): Promise<StartRunResult> {
  const threadRef = threadRefFor(input);
  const dispatcher = buildDispatcher(services, input);
  const result = await dispatcher.dispatch({
    type: "message",
    intentId: input.idempotencyKey,
    threadRef,
    author: input.author,
    message: input.message,
  });

  if (result.outcome === "duplicate") {
    const claimed = await services.db.runIntent.findUnique({
      where: { orgId_id: { orgId: services.orgId, id: input.idempotencyKey } },
      select: { runId: true },
    });
    log.info("Run request was a duplicate", { threadRef, runId: claimed?.runId ?? null });
    return { outcome: "duplicate", runId: claimed?.runId ?? null, threadRef };
  }
  if (result.outcome !== "new-run" && result.outcome !== "steer") {
    throw new Error(`unexpected dispatch outcome for a message: ${result.outcome}`);
  }

  const outcome = result.outcome === "new-run" ? "started" : "steered";
  const runId = result.outcome === "new-run" ? result.run.id : result.runId;
  await services.db.runIntent.update({
    where: { orgId_id: { orgId: services.orgId, id: input.idempotencyKey } },
    data: { runId, outcome },
  });
  log.info("Run request accepted", { threadRef, runId, outcome, trigger: input.trigger });
  return { outcome, runId, threadRef };
}
