import type {
  DispatchIntent,
  DispatchResult,
  ElicitationRecord,
  MessageIntent,
  PrincipalRef,
  RunRecord,
  TranscriptMessage,
} from "@trema/harness";
import { InputDispatcher } from "@trema/harness";

import type { Prisma } from "#server/generated/prisma/client.js";
import { log } from "#server/lib/logger/index.js";
import type { ModelChainEntry } from "#server/services/model-providers/index.js";
import type { RunServices } from "#server/services/runs/index.js";

/** Where a run comes from, beyond the message itself. */
export interface RunOrigin {
  /** Every trigger enters the same dispatch; `resume` re-enqueues instead of creating a run. */
  trigger: "message" | "api" | "schedule";
  surface: string;
  locationRef: string;
  /** A one-to-one location on a surface that also has shared locations. */
  directMessage?: boolean;
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
  /** Idempotency: at-least-once callers, exactly-once runs. */
  intentId: string;
  /** Defaults to the surface and location, so one location is one thread. */
  threadRef?: string;
  /** Provider-native thread id for the context session; null means the surface has no threads. */
  surfaceThreadRef?: string | null;
  message: TranscriptMessage;
  author: PrincipalRef;
  /** The picker choice to pin when this message creates a run. */
  model?: ModelChainEntry;
}

/**
 * Where the message landed. The caller never waits for execution.
 *
 * `follow-up` is the classification a message gets when it starts the next run
 * behind one that is still finishing. Dispatch cannot produce it yet — the
 * thread lock serializes classification, so a message either steers the active
 * run or starts a new one — but it is part of the contract callers code
 * against.
 */
export interface StartRunResult {
  outcome: "started" | "steered" | "follow-up" | "duplicate";
  /** The run the message landed on, or `null` for a duplicate still being routed. */
  runId: string | null;
  threadRef: string;
}

/** Services plus the request they act on. */
export interface StartRunOptions {
  services: RunServices;
  input: StartRunInput;
  /** Checked under the dispatch lock, and only when the message creates a run. */
  validateModel?: (model: ModelChainEntry) => Promise<void>;
}

function threadRefFor(input: StartRunInput): string {
  return input.threadRef ?? `${input.surface}:${input.locationRef}`;
}

function buildDispatcher(
  services: RunServices,
  input: StartRunInput,
  validateModel: StartRunOptions["validateModel"],
): InputDispatcher {
  const createRun = async (intent: MessageIntent): Promise<RunRecord> => {
    if (input.model !== undefined && validateModel !== undefined) {
      try {
        await validateModel(input.model);
      } catch (error) {
        // Dispatch claims the id before it classifies the message. A rejected
        // picker value is not an accepted intent, so release that fresh claim
        // while the thread lock still excludes every competing use of the id.
        await services.db.runIntent.deleteMany({
          where: { orgId: services.orgId, id: intent.intentId, runId: null },
        });
        throw error;
      }
    }
    const waiting = await services.db.runQueuedInput.findFirst({
      where: { orgId: services.orgId, kind: "follow_up", threadRef: intent.threadRef },
      orderBy: { position: "asc" },
      select: { modelProviderName: true, modelModelId: true },
    });
    const model =
      waiting === null
        ? input.model
        : waiting.modelProviderName === null || waiting.modelModelId === null
          ? undefined
          : { providerName: waiting.modelProviderName, modelId: waiting.modelModelId };
    const snapshot = await services.context.open({
      surface: input.surface,
      locationRef: input.locationRef,
      // The session names the thread it serves, so the conversation the run's
      // messages land on is that thread and not the whole location.
      ...(input.surfaceThreadRef === null
        ? {}
        : { threadRef: input.surfaceThreadRef ?? intent.threadRef }),
      ...(input.directMessage === undefined ? {} : { directMessage: input.directMessage }),
      ...(input.requester === undefined ? {} : { requester: input.requester }),
    });
    const run = await services.lifecycle.create({
      threadRef: intent.threadRef,
      trigger: input.trigger,
      sessionId: snapshot.sessionId,
    });
    if (model !== undefined) {
      await services.db.agentRun.update({
        where: { id: run.id },
        data: {
          modelProviderName: model.providerName,
          modelModelId: model.modelId,
        },
      });
    }
    // Recorded as soon as the run exists, so a crash later in routing still
    // leaves the claim answerable instead of permanently null.
    await services.db.runIntent.updateMany({
      where: { orgId: services.orgId, id: intent.intentId },
      data: { runId: run.id },
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
      await requireStopped(services, intent);
    },
    retry: async (intent) =>
      services.lifecycle.retry({ runId: intent.runId, execute: services.enqueue }),
    feedback: async (intent) => {
      await services.lifecycle.feedback(intent.runId, intent.value);
    },
  });
}

/**
 * Stops through the lifecycle, surfacing a lost race as the state error. The
 * store rechecks the run's state atomically with the stop record, so a run
 * that reached terminal between validation and here gains no stop fact and
 * the caller hears `run_not_active`, never a false `stopped`.
 */
async function requireStopped(
  services: RunServices,
  intent: { intentId: string; runId: string; by: PrincipalRef },
): Promise<void> {
  const result = await services.lifecycle.stop(intent.intentId, intent.runId, intent.by);
  if (result === "run-not-active") {
    throw new IntentStateError(
      "run_not_active",
      "Run reached a terminal state before the stop landed",
    );
  }
}

/**
 * A claim this old with no recorded run cannot still be in flight: routing is a
 * session open and a few row writes. Past it, the claiming call is dead and the
 * key can be released.
 */
const STALE_CLAIM_MS = 60_000;

/**
 * Enters a message into the same per-thread dispatch every trigger uses.
 *
 * An active run absorbs the message as steering; otherwise a new run starts.
 * The result reports where the message landed and nothing about execution: a
 * caller observes progress through the run's event stream.
 */
export async function startRun(options: StartRunOptions): Promise<StartRunResult> {
  return dispatchRun(options, true);
}

async function dispatchRun(
  { services, input, validateModel }: StartRunOptions,
  reclaimStale: boolean,
): Promise<StartRunResult> {
  const threadRef = threadRefFor(input);
  const dispatcher = buildDispatcher(services, input, validateModel);
  const result = await dispatcher.dispatch({
    type: "message",
    intentId: input.intentId,
    threadRef,
    author: input.author,
    message: input.message,
  });

  if (result.outcome === "duplicate") {
    const claim = await claimForDuplicate(
      services,
      input.intentId,
      MESSAGE_FINGERPRINT,
      reclaimStale,
    );
    if (claim.kind === "reclaimed") {
      log.warn("Reclaimed a stale run request", { threadRef });
      return dispatchRun(
        { services, input, ...(validateModel === undefined ? {} : { validateModel }) },
        false,
      );
    }
    if (claim.runId !== null && claim.outcome === null) {
      await resumeClaimedMessageRouting(services, input, claim.runId);
    }
    log.info("Run request was a duplicate", { threadRef, runId: claim.runId });
    return { outcome: "duplicate", runId: claim.runId, threadRef };
  }
  if (result.outcome !== "new-run" && result.outcome !== "steer") {
    throw new Error(`unexpected dispatch outcome for a message: ${result.outcome}`);
  }

  const outcome = result.outcome === "new-run" ? "started" : "steered";
  const runId = result.outcome === "new-run" ? result.run.id : result.runId;
  if (result.outcome === "steer" && input.model !== undefined) {
    await services.db.runQueuedInput.updateMany({
      where: { orgId: services.orgId, id: input.intentId, runId },
      data: {
        modelProviderName: input.model.providerName,
        modelModelId: input.model.modelId,
      },
    });
  }
  await services.db.runIntent.update({
    where: { orgId_id: { orgId: services.orgId, id: input.intentId } },
    data: { runId, outcome },
  });
  log.info("Run request accepted", { threadRef, runId, outcome, trigger: input.trigger });
  return { outcome, runId, threadRef };
}

/** Finishes the durable steps left between recording a new run and routing it. */
async function resumeClaimedMessageRouting(
  services: RunServices,
  input: StartRunInput,
  runId: string,
): Promise<void> {
  const wasQueued = await services.db.$transaction(async (tx) => {
    const [run] = await tx.$queryRaw<{ state: string; threadRef: string }[]>`
      SELECT "state", "threadRef" FROM "AgentRun"
      WHERE "id" = ${runId} AND "orgId" = ${services.orgId}
      FOR UPDATE`;
    if (run === undefined) throw new Error(`claimed run does not exist: ${runId}`);
    if (run.state !== "queued") return false;

    if (input.toolAllowlist !== undefined && input.toolAllowlist.length > 0) {
      await tx.agentRun.update({
        where: { id: runId },
        data: { toolAllowlist: input.toolAllowlist },
      });
    }
    const inserted = await tx.runQueuedInput.createMany({
      data: [
        {
          id: input.intentId,
          orgId: services.orgId,
          kind: "steering",
          runId,
          threadRef: run.threadRef,
          message: input.message as unknown as Prisma.InputJsonValue,
          author: input.author as unknown as Prisma.InputJsonValue,
        },
      ],
      skipDuplicates: true,
    });
    if (inserted.count === 0) {
      const existing = await tx.runQueuedInput.findUnique({
        where: { id: input.intentId },
        select: { orgId: true, kind: true, runId: true },
      });
      if (
        existing?.orgId !== services.orgId ||
        existing.kind !== "steering" ||
        existing.runId !== runId
      ) {
        throw new Error(`queued input id belongs to a different route: ${input.intentId}`);
      }
    }
    return true;
  });

  if (wasQueued) {
    const run = await services.store.getRun(runId);
    if (run === undefined) throw new Error(`claimed run does not exist: ${runId}`);
    if (run.state === "queued") await services.enqueue(run);
  }
  await services.db.runIntent.updateMany({
    where: { orgId: services.orgId, id: input.intentId, runId, outcome: null },
    data: { outcome: "started" },
  });
  log.warn("Resumed a partially routed run request", { runId, threadRef: threadRefFor(input) });
}

type DuplicateClaim =
  | { kind: "duplicate"; runId: string | null; outcome: string | null }
  | { kind: "reclaimed" };

/** What the current call asks, checked against what a claim was made for. */
interface ClaimFingerprint {
  kind: string;
  targetId?: string;
}

/** The fingerprint the message dispatch claims an id under. */
const MESSAGE_FINGERPRINT: ClaimFingerprint = { kind: "message" };

/** The fingerprint a target intent claims an id under, mirroring dispatch. */
function targetFingerprint(intent: TargetIntent): ClaimFingerprint {
  if (intent.type === "resolve") return { kind: "resolve", targetId: intent.elicitationId };
  return { kind: intent.type, targetId: intent.runId };
}

/**
 * Refuses a reuse of an id whose claim was made for a different intent or
 * target: answering `duplicate` would silently swallow the new action.
 * Claims recorded before fingerprints existed (`kind` null) pass unchecked.
 * @throws {IntentMismatchError} When the stored fingerprint differs.
 */
function assertClaimMatches(
  stored: { kind: string | null; targetId: string | null },
  expected: ClaimFingerprint,
  intentId: string,
): void {
  if (stored.kind === null) return;
  if (stored.kind === expected.kind && (stored.targetId ?? undefined) === expected.targetId) {
    return;
  }
  throw new IntentMismatchError(`Intent id '${intentId}' was already used for a different intent`);
}

/**
 * Reads a duplicate's original claim, releasing one whose claiming call died
 * between claiming the key and recording where it routed. The guards on
 * `runId` and `createdAt` keep a concurrent routing's fresh claim untouched.
 * @throws {IntentMismatchError} When the claim was made by a different intent.
 */
async function claimForDuplicate(
  services: RunServices,
  intentId: string,
  expected: ClaimFingerprint,
  reclaimStale: boolean,
): Promise<DuplicateClaim> {
  const claimed = await services.db.runIntent.findUnique({
    where: { orgId_id: { orgId: services.orgId, id: intentId } },
    select: { runId: true, outcome: true, createdAt: true, kind: true, targetId: true },
  });
  if (claimed !== null) assertClaimMatches(claimed, expected, intentId);
  if (
    reclaimStale &&
    claimed !== null &&
    claimed.runId === null &&
    Date.now() - claimed.createdAt.getTime() >= STALE_CLAIM_MS
  ) {
    const released = await services.db.runIntent.deleteMany({
      where: { orgId: services.orgId, id: intentId, runId: null, createdAt: claimed.createdAt },
    });
    if (released.count === 1) return { kind: "reclaimed" };
  }
  return {
    kind: "duplicate",
    runId: claimed?.runId ?? null,
    outcome: claimed?.outcome ?? null,
  };
}

/** The elicitation decision, stop, retry, or feedback a caller aims at existing work. */
export type TargetIntent =
  | { type: "resolve"; elicitationId: string; optionId: string }
  | { type: "stop"; runId: string }
  | { type: "retry"; runId: string }
  | { type: "feedback"; runId: string; verdict: "up" | "down"; comment?: string };

/** One decision or lifecycle request aimed at a run or elicitation. */
export interface SubmitTargetIntentInput {
  /** Idempotency: at-least-once callers, exactly-once effects. */
  intentId: string;
  /** Who acted. Recorded on the stop fact, the resolution, or the audit row. */
  by: PrincipalRef;
  intent: TargetIntent;
}

/**
 * Where the intent landed. Each outcome names the fact durably recorded before
 * the caller heard it: the resolution row, the stop fact, the retry run, or
 * the feedback audit entry. Execution is observed on the run's event stream,
 * never here.
 */
export interface TargetIntentResult {
  outcome: "resolved" | "stopped" | "retried" | "recorded" | "duplicate";
  /** For `retried`, the new run; otherwise the run the intent addressed. */
  runId: string | null;
  threadRef: string;
}

/** Services plus the request they act on. */
export interface SubmitTargetIntentOptions {
  services: RunServices;
  input: SubmitTargetIntentInput;
}

/** The run or elicitation a target intent names does not exist in this organization. */
export class IntentTargetError extends Error {
  constructor(
    readonly code: "run_not_found" | "elicitation_not_found",
    message: string,
  ) {
    super(message);
    this.name = "IntentTargetError";
  }
}

/** The target exists but its state does not admit the intent. */
export class IntentStateError extends Error {
  constructor(
    readonly code: "run_not_active" | "run_not_retryable" | "elicitation_resolved",
    message: string,
  ) {
    super(message);
    this.name = "IntentStateError";
  }
}

/** The intent names an option the elicitation does not offer. */
export class IntentOptionError extends Error {
  readonly code = "unknown_option";

  constructor(message: string) {
    super(message);
    this.name = "IntentOptionError";
  }
}

/**
 * The intent id was already claimed by a different kind of intent or target.
 * Answering `duplicate` would silently swallow the new action, so a
 * mismatched reuse is a conflict the caller must hear.
 */
export class IntentMismatchError extends Error {
  readonly code = "intent_mismatch";

  constructor(message: string) {
    super(message);
    this.name = "IntentMismatchError";
  }
}

/** Run states a stop can still reach: execution pending, live, or parked. */
const STOPPABLE_RUN_STATES: RunRecord["state"][] = [
  "queued",
  "running",
  "awaiting_approval",
  "awaiting_input",
];

/** Run states a retry can follow, mirroring the lifecycle's own guard. */
const RETRYABLE_RUN_STATES: RunRecord["state"][] = ["failed", "stale"];

/**
 * The decision derives from the elicitation and the chosen option, never from
 * the caller: the wire intent carries only the option id (interface 03).
 * Approvals and confirmations gate a pending call — the deny option refuses
 * it, every other option lets it proceed — while choice and form elicitations
 * are answered with the option itself.
 */
function deriveDecision(
  event: ElicitationRecord["event"],
  option: ElicitationRecord["event"]["options"][number],
): "approved" | "denied" | "answered" {
  if (event.kind === "choice" || event.kind === "form") return "answered";
  return option.id === "deny" || option.style === "danger" ? "denied" : "approved";
}

type TargetDispatchIntent = Exclude<DispatchIntent, MessageIntent>;

/**
 * Loads and validates the addressed run or elicitation, and shapes the
 * dispatch intent. Validation runs before the intent id is claimed, so a
 * refused call can retry with the same id once the caller fixes it.
 */
async function resolveTarget(
  services: RunServices,
  input: SubmitTargetIntentInput,
): Promise<TargetDispatchIntent> {
  const { intentId, by, intent } = input;
  if (intent.type === "resolve") {
    const record = await services.store.getElicitation(intent.elicitationId);
    if (record === undefined) {
      throw new IntentTargetError("elicitation_not_found", "Elicitation not found");
    }
    if (record.resolution !== undefined) {
      throw new IntentStateError("elicitation_resolved", "Elicitation is already resolved");
    }
    const option = record.event.options.find((candidate) => candidate.id === intent.optionId);
    if (option === undefined) {
      throw new IntentOptionError(`Elicitation offers no option '${intent.optionId}'`);
    }
    const run = await services.store.getRun(record.runId);
    if (run === undefined) {
      // The schema keeps an elicitation's run from going away underneath it;
      // deny by default if it somehow did.
      throw new IntentTargetError("run_not_found", "Run not found");
    }
    return {
      type: "resolve",
      intentId,
      threadRef: run.threadRef,
      runId: run.id,
      elicitationId: intent.elicitationId,
      optionId: intent.optionId,
      decision: deriveDecision(record.event, option),
      scope: option.scope ?? "once",
      by,
    };
  }

  const run = await services.store.getRun(intent.runId);
  if (run === undefined) throw new IntentTargetError("run_not_found", "Run not found");
  if (intent.type === "stop" && !STOPPABLE_RUN_STATES.includes(run.state)) {
    throw new IntentStateError("run_not_active", `Run is ${run.state}; only an active run stops`);
  }
  if (intent.type === "retry" && !RETRYABLE_RUN_STATES.includes(run.state)) {
    throw new IntentStateError(
      "run_not_retryable",
      `Run is ${run.state}; only a failed or stale run retries`,
    );
  }
  const base = { intentId, threadRef: run.threadRef, runId: run.id, by };
  if (intent.type === "stop") return { type: "stop", ...base };
  if (intent.type === "retry") return { type: "retry", ...base };
  return { type: "feedback", ...base, value: intent.verdict };
}

function buildTargetDispatcher(
  services: RunServices,
  input: SubmitTargetIntentInput,
): InputDispatcher {
  return new InputDispatcher({
    store: services.store,
    lock: services.lock,
    // Dispatch routes a target intent by its type alone; only a message can
    // reach run creation, and none is ever handed to this dispatcher.
    createRun: async () => {
      throw new Error("a target intent cannot create a run");
    },
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
      await requireStopped(services, intent);
    },
    retry: async (intent) =>
      services.lifecycle.retry({ runId: intent.runId, execute: services.enqueue }),
    // Feedback is an audit fact in v1: recorded with attribution, mutating no
    // run. Relaying it into the context app arrives with the data plane.
    feedback: async (intent) => {
      const comment = input.intent.type === "feedback" ? input.intent.comment : undefined;
      await services.db.auditLog.create({
        data: {
          orgId: services.orgId,
          actorPrincipalId: intent.by.principalId,
          action: "run.feedback",
          subject: intent.runId,
          payload: { verdict: intent.value, ...(comment === undefined ? {} : { comment }) },
        },
      });
    },
  });
}

const TARGET_OUTCOMES = {
  resolve: "resolved",
  stop: "stopped",
  retry: "retried",
  feedback: "recorded",
} as const;

/**
 * Routes a decision, stop, retry, or feedback through the same idempotent
 * dispatch messages use. The named machinery does the work — the interrupt
 * manager for resolutions, the run lifecycle for stops and retries — and the
 * result reports the durably recorded fact, never execution.
 * @throws {IntentTargetError} When the named run or elicitation does not exist.
 * @throws {IntentStateError} When the target's state does not admit the intent.
 * @throws {IntentOptionError} When the elicitation does not offer the option.
 * @throws {IntentMismatchError} When the id was claimed by a different intent.
 */
export async function submitTargetIntent(
  options: SubmitTargetIntentOptions,
): Promise<TargetIntentResult> {
  return dispatchTargetIntent(options, true);
}

/**
 * Answers a replay whose first call already recorded where it routed. The
 * claim, not the target's current state, is the truth a duplicate reads back:
 * a stopped run is terminal, and its stop's replay must still say `duplicate`,
 * never `run_not_active`. In-flight and stale claims return nothing and fall
 * through to dispatch, whose own claim check and reclaim handle them.
 * @throws {IntentMismatchError} When the claim was made by a different intent.
 */
async function routedDuplicate(
  services: RunServices,
  input: SubmitTargetIntentInput,
): Promise<TargetIntentResult | undefined> {
  const claimed = await services.db.runIntent.findUnique({
    where: { orgId_id: { orgId: services.orgId, id: input.intentId } },
    select: { runId: true, kind: true, targetId: true },
  });
  if (claimed === null) return undefined;
  assertClaimMatches(claimed, targetFingerprint(input.intent), input.intentId);
  if (claimed.runId === null) return undefined;
  const run = await services.store.getRun(claimed.runId);
  if (run === undefined) return undefined;
  log.info("Intent was a duplicate", { threadRef: run.threadRef, runId: run.id });
  return { outcome: "duplicate", runId: run.id, threadRef: run.threadRef };
}

async function dispatchTargetIntent(
  { services, input }: SubmitTargetIntentOptions,
  reclaimStale: boolean,
): Promise<TargetIntentResult> {
  // The idempotency claim is consulted before state validation, so an
  // at-least-once retry of a completed intent replays its routing instead of
  // tripping over the state its own success left behind.
  const routed = await routedDuplicate(services, input);
  if (routed !== undefined) return routed;

  const target = await resolveTarget(services, input);
  let result: DispatchResult;
  try {
    result = await buildTargetDispatcher(services, input).dispatch(target);
  } catch (error) {
    // A state refusal raised under the claim — the stop that lost its race —
    // releases the fresh claim, keeping the id as retryable as one refused
    // before claiming. The `runId: null` guard spares any routed claim.
    if (error instanceof IntentStateError) {
      await services.db.runIntent.deleteMany({
        where: { orgId: services.orgId, id: input.intentId, runId: null },
      });
    }
    throw error;
  }

  if (result.outcome === "duplicate") {
    const claim = await claimForDuplicate(
      services,
      input.intentId,
      targetFingerprint(input.intent),
      reclaimStale,
    );
    if (claim.kind === "reclaimed") {
      log.warn("Reclaimed a stale intent claim", { threadRef: target.threadRef });
      return dispatchTargetIntent({ services, input }, false);
    }
    log.info("Intent was a duplicate", { threadRef: target.threadRef, runId: claim.runId });
    return { outcome: "duplicate", runId: claim.runId, threadRef: target.threadRef };
  }
  if (result.outcome === "new-run" || result.outcome === "steer") {
    throw new Error(`unexpected dispatch outcome for a ${target.type}: ${result.outcome}`);
  }

  const outcome = TARGET_OUTCOMES[result.outcome];
  const runId = result.outcome === "retry" ? result.run.id : result.runId;
  await services.db.runIntent.update({
    where: { orgId_id: { orgId: services.orgId, id: input.intentId } },
    data: { runId, outcome },
  });
  log.info("Intent accepted", { threadRef: target.threadRef, runId, outcome });
  return { outcome, runId, threadRef: target.threadRef };
}
