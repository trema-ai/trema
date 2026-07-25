import type {
  ContextSession,
  OpenSessionRequest,
  SessionSnapshot,
  SessionStanding,
  TranscriptMessage,
  Usage,
} from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";
import { closeSession, openSession, renewSession } from "#server/services/sessions/index.js";

/**
 * A data-plane call the context app does not serve yet.
 *
 * The session handshake — open, renew, close — is built; memory, skills,
 * connector proxying, and approval resolution arrive with the context app's
 * data plane. Naming the gap beats a silent fallback that pretends to work.
 */
export class ContextCapabilityUnavailableError extends Error {
  readonly code = "context_capability_unavailable";

  constructor(readonly capability: string) {
    super(`The context app does not serve '${capability}' yet`);
    this.name = "ContextCapabilityUnavailableError";
  }
}

/** Persistence, tenancy, and budget settings for the in-process context session client. */
export interface ServerContextSessionOptions {
  db: Database;
  orgId: string;
  standingBudgetTokens?: number;
}

function unavailable(capability: string): never {
  throw new ContextCapabilityUnavailableError(capability);
}

/**
 * The `ContextSession` port against this deployment's own context tables.
 *
 * A run on the server profile talks to the context app in process. The device
 * and sandbox profiles use an HTTP client against the same protocol.
 */
export class ServerContextSession implements ContextSession {
  readonly #db: Database;
  readonly #orgId: string;
  readonly #standingBudgetTokens: number | undefined;

  constructor(options: ServerContextSessionOptions) {
    this.#db = options.db;
    this.#orgId = options.orgId;
    this.#standingBudgetTokens = options.standingBudgetTokens;
  }

  async open(request: OpenSessionRequest): Promise<SessionSnapshot> {
    const opened = await openSession(this.#db, {
      orgId: this.#orgId,
      surface: request.surface,
      locationRef: String(request.locationRef),
      ...(request.requester === undefined ? {} : { requester: request.requester }),
      ...(this.#standingBudgetTokens === undefined
        ? {}
        : { standingBudgetTokens: this.#standingBudgetTokens }),
    });
    return {
      sessionId: opened.session.id,
      mode: opened.session.mode,
      scopeChain: opened.scopeChain,
      standing: opened.standing.standing,
      tools: opened.tools,
      policySnapshot: opened.policySnapshot,
      snapshotHash: opened.session.snapshotHash,
    };
  }

  async renew(sessionId: string): Promise<void> {
    await renewSession(this.#db, { orgId: this.#orgId, sessionId });
  }

  async close(sessionId: string, usage: Usage): Promise<void> {
    await closeSession(this.#db, { orgId: this.#orgId, sessionId, usage: { ...usage } });
  }

  async reportMessages(_sessionId: string, _messages: TranscriptMessage[]): Promise<void> {
    unavailable("report-messages");
  }

  async searchContext(): Promise<never> {
    unavailable("search-context");
  }

  async getItem(): Promise<never> {
    unavailable("get-item");
  }

  async saveMemory(): Promise<never> {
    unavailable("save-memory");
  }

  async updateMemory(): Promise<never> {
    unavailable("update-memory");
  }

  async loadSkill(): Promise<never> {
    unavailable("load-skill");
  }

  async useConnector(): Promise<never> {
    unavailable("use-connector");
  }

  async proposeSkill(): Promise<never> {
    unavailable("propose-skill");
  }

  async fetchTranscript(): Promise<never> {
    unavailable("fetch-transcript");
  }

  async resolveApproval(): Promise<never> {
    unavailable("resolve-approval");
  }

  async proposePolicyEdit(): Promise<never> {
    unavailable("propose-policy-edit");
  }

  async reportFeedback(): Promise<never> {
    unavailable("report-feedback");
  }
}

/** Reads the standing context pinned on a session row. */
export function toSessionStanding(standing: unknown): SessionStanding {
  const value = (standing ?? {}) as Partial<SessionStanding>;
  return {
    instructions: value.instructions ?? "",
    rules: value.rules ?? [],
    skillIndex: value.skillIndex ?? [],
  };
}
