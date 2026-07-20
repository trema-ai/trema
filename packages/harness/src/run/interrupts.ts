import type { PrincipalRef } from "../events/index.js";
import type { RunEventData } from "../events/index.js";
import type {
  ContextSession,
  ElicitationRecord,
  ResolutionScope,
  RunRecord,
  RunStore,
} from "../ports/index.js";

export interface ResolveInterruptInput {
  elicitationId: string;
  optionId: string;
  decision: "approved" | "denied" | "answered";
  scope?: ResolutionScope;
  by: PrincipalRef;
  reason?: string;
}

export interface InterruptManagerOptions {
  store: RunStore;
  context: ContextSession;
  now: () => string;
  isParticipant: (run: RunRecord, principal: PrincipalRef) => Promise<boolean> | boolean;
  enqueueResume: (run: RunRecord) => Promise<void>;
  expiryPrincipal?: PrincipalRef;
}

export type InterruptSource =
  | {
      type: "approval_required";
      callId: string;
      approvalId: string;
      reason: string;
    }
  | {
      type: "ask_user";
      callId: string;
      prompt: string;
      kind?: "choice" | "form";
      options: Array<{ id: string; label: string }>;
    }
  | {
      type: "confirmation";
      callId: string;
      prompt: string;
      options?: Array<{ id: string; label: string; style?: "primary" | "danger" }>;
    };

export function createBlockingElicitation(
  elicitationId: string,
  source: InterruptSource,
): Extract<RunEventData, { type: "elicitation" }> {
  if (source.type === "approval_required") {
    return {
      type: "elicitation",
      elicitationId,
      kind: "approval",
      prompt: source.reason,
      reference: { callId: source.callId, approvalId: source.approvalId },
      options: [
        { id: "approve", label: "Approve", scope: "once" },
        { id: "deny", label: "Deny", style: "danger", scope: "once" },
      ],
      blocking: true,
    };
  }
  if (source.type === "ask_user") {
    return {
      type: "elicitation",
      elicitationId,
      kind: source.kind ?? "choice",
      prompt: source.prompt,
      reference: { callId: source.callId },
      options: source.options,
      blocking: true,
    };
  }
  return {
    type: "elicitation",
    elicitationId,
    kind: "confirmation",
    prompt: source.prompt,
    reference: { callId: source.callId },
    options: source.options ?? [
      { id: "approve", label: "Continue", scope: "once" },
      { id: "deny", label: "Deny", style: "danger", scope: "once" },
    ],
    blocking: true,
  };
}

export class InterruptManager {
  readonly #options: InterruptManagerOptions;
  readonly #resolutionTails = new Map<string, Promise<void>>();

  constructor(options: InterruptManagerOptions) {
    this.#options = options;
  }

  async resolve(input: ResolveInterruptInput): Promise<"resolved" | "already-resolved"> {
    return this.#withResolutionLock(input.elicitationId, () => this.#resolve(input));
  }

  async #resolve(input: ResolveInterruptInput): Promise<"resolved" | "already-resolved"> {
    const record = await this.#requireElicitation(input.elicitationId);
    if (record.resolution !== undefined) return "already-resolved";
    const run = await this.#requireRun(record.runId);
    if (run.state === "stale") throw new Error(`stale run cannot be resumed: ${run.id}`);
    if (record.expiresAt !== undefined && record.expiresAt <= this.#options.now()) {
      await this.expire(record.event.elicitationId);
      throw new Error(`elicitation has expired: ${record.event.elicitationId}`);
    }

    const scope = input.scope ?? "once";
    const approvalId = record.event.reference?.approvalId;
    if (approvalId !== undefined) {
      if (run.sessionId === undefined) throw new Error(`approval run has no session: ${run.id}`);
      if (input.decision === "answered") throw new Error("approval requires approve or deny");
      await this.#options.context.resolveApproval(
        run.sessionId,
        approvalId,
        input.decision,
        scope,
      );
    } else if (!(await this.#options.isParticipant(run, input.by))) {
      throw new Error(`principal is not a thread participant: ${input.by.principalId}`);
    }

    const result = await this.#options.store.resolveElicitation(input.elicitationId, {
      optionId: input.optionId,
      decision: input.decision,
      scope,
      by: input.by,
      at: this.#options.now(),
      ...(input.reason === undefined ? {} : { reason: input.reason }),
    });
    if (result === "already-resolved") return result;

    if (scope === "always") {
      if (run.sessionId === undefined) throw new Error(`policy proposal has no session: ${run.id}`);
      await this.#options.context.proposePolicyEdit(
        run.sessionId,
        await this.#toolName(run, record),
      );
    }
    await this.#options.enqueueResume(run);
    return "resolved";
  }

  async expire(elicitationId: string): Promise<"resolved" | "already-resolved"> {
    const record = await this.#requireElicitation(elicitationId);
    if (record.resolution !== undefined) return "already-resolved";
    if (record.expiresAt === undefined || record.expiresAt > this.#options.now()) {
      throw new Error(`elicitation has not expired: ${elicitationId}`);
    }
    return this.#options.store.expireElicitation(
      elicitationId,
      this.#options.expiryPrincipal ?? { principalId: "system" },
      this.#options.now(),
    );
  }

  async #requireElicitation(elicitationId: string): Promise<ElicitationRecord> {
    const record = await this.#options.store.getElicitation(elicitationId);
    if (record === undefined) throw new Error(`unknown elicitation: ${elicitationId}`);
    return record;
  }

  async #withResolutionLock<T>(elicitationId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.#resolutionTails.get(elicitationId) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const tail = previous.then(() => current);
    this.#resolutionTails.set(elicitationId, tail);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      if (this.#resolutionTails.get(elicitationId) === tail) {
        this.#resolutionTails.delete(elicitationId);
      }
    }
  }

  async #requireRun(runId: string): Promise<RunRecord> {
    const run = await this.#options.store.getRun(runId);
    if (run === undefined) throw new Error(`unknown run: ${runId}`);
    return run;
  }

  async #toolName(run: RunRecord, record: ElicitationRecord): Promise<string> {
    const callId = record.event.reference?.callId;
    if (callId !== undefined) {
      for (const turn of await this.#options.store.listTurns(run.id)) {
        const call = turn.message.blocks.find(
          (block) => block.type === "toolCall" && block.callId === callId,
        );
        if (call?.type === "toolCall") return call.name;
      }
    }
    return callId ?? run.id;
  }
}
