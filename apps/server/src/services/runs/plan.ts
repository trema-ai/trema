import type { ModelRef, RunRecord, ToolDef } from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";
import { toSessionStanding } from "#server/services/runs/context.js";
import { type RunExecutionPlan, RunNotStartableError } from "#server/services/runs/driver.js";
import { renewSession } from "#server/services/sessions/index.js";

/**
 * Intersects the session's resolved tools with a run's allowlist.
 *
 * An empty allowlist means "everything the session resolved". A name the
 * session did not resolve is dropped, so an allowlist can only ever narrow: a
 * scheduled run can never reach a tool an ordinary run in the same scope could
 * not reach.
 */
export function narrowTools(tools: ToolDef[], allowlist: readonly string[]): ToolDef[] {
  if (allowlist.length === 0) return tools;
  const allowed = new Set(allowlist);
  return tools.filter((tool) => allowed.has(tool.name));
}

/** Persistence, model, and time dependencies for the session-backed plan. */
export interface SessionRunPlanOptions {
  db: Database;
  orgId: string;
  model: ModelRef;
  /** Hard cap on turns per run. */
  maxTurns?: number;
  /** Milliseconds a blocking elicitation stays resolvable. */
  elicitationTtlMs?: number;
  now?: () => Date;
}

/**
 * Reads one execution's context from the run's pinned session.
 *
 * The snapshot was fixed when the session opened, so a control-plane edit never
 * changes what a running or resuming run sees. An expired token is renewed
 * rather than reopened, which is what lets a run parked for days resume against
 * the same snapshot.
 */
export function createSessionRunPlan(
  options: SessionRunPlanOptions,
): (run: RunRecord) => Promise<RunExecutionPlan> {
  const now = options.now ?? (() => new Date());

  return async (run) => {
    if (run.sessionId === undefined) {
      throw new RunNotStartableError(run.id, `run has no context session: ${run.id}`);
    }
    const [row, session] = await Promise.all([
      options.db.agentRun.findUnique({
        where: { orgId_id: { orgId: options.orgId, id: run.id } },
        select: { toolAllowlist: true },
      }),
      options.db.contextSession.findFirst({
        where: { orgId: options.orgId, id: run.sessionId },
      }),
    ]);
    if (session === null) {
      throw new RunNotStartableError(run.id, `context session not found: ${run.sessionId}`);
    }
    if (session.closedAt !== null) {
      throw new RunNotStartableError(run.id, `context session is closed: ${run.sessionId}`);
    }

    const at = now();
    if (session.expiresAt <= at) {
      await renewSession(options.db, { orgId: options.orgId, sessionId: session.id, now: at });
    }

    // Connector tool definitions join the session when the connector proxy
    // reaches the data plane; the allowlist narrows whatever it resolves.
    const sessionTools: ToolDef[] = [];

    return {
      model: options.model,
      standing: toSessionStanding(session.standing),
      tools: narrowTools(sessionTools, row?.toolAllowlist ?? []),
      // The opening message is queued as steering, so the loop drains it at the
      // first turn boundary and no message needs to be replayed here.
      threadMessages: [],
      ...(options.maxTurns === undefined ? {} : { maxTurns: options.maxTurns }),
      ...(options.elicitationTtlMs === undefined
        ? {}
        : {
            elicitationExpiresAt: new Date(at.getTime() + options.elicitationTtlMs).toISOString(),
          }),
    };
  };
}
