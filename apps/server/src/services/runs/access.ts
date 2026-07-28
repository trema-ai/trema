import type { AgentRun, ContextSession, Scope } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import {
  type AuthorizePrincipal,
  effectiveRolesAtScope,
  roleAllowsCapability,
} from "#server/services/authorize/index.js";

/** What a viewer may see of one run. */
export type RunAccessLevel = "full" | "metadata" | "none";

/** Dependencies plus the question: may this principal see this run? */
export interface ResolveRunAccessOptions {
  db: Database;
  orgId: string;
  principal: AuthorizePrincipal;
  runId: string;
}

/**
 * The verdict, carrying the rows the check already fetched so a caller never
 * re-reads them. `session` and `scope` are `null` only for a sessionless run —
 * an anomaly a real trigger never produces (see {@link resolveRunAccess}).
 */
export type RunAccess =
  | { access: "full"; run: AgentRun; session: ContextSession | null; scope: Scope | null }
  | { access: "metadata"; run: AgentRun; session: ContextSession | null; scope: Scope | null }
  | { access: "none" };

/**
 * The one access rule for run reads: run → session → scope → verdict.
 *
 * Every read endpoint over runs — the JSON reads, the SSE tail, output
 * resolution — answers authorization through this helper and nowhere else.
 *
 * - Viewers are the principals holding read at the run's scope: every role has
 *   in-scope read, and org roles inherit into shared scopes, so org admins see
 *   all shared-scope runs.
 * - Personal-scope runs are the owner's. Principals holding an audit-grade org
 *   role (admin or owner) get `metadata` — that the run happened, which tools
 *   were called — never content. Everyone else gets `none`.
 * - The scope comes from the run's session (`AgentRun.sessionId` →
 *   `ContextSession.scopeId`), pinned when the session opened, so a later
 *   binding change never re-scopes visibility of past runs.
 * - Agent-kind principals hold no control-plane role and always get `none`.
 *
 * A run with no session cannot come from a real trigger — dispatch opens a
 * session before it creates the run (`trigger.ts`), and the schema keeps the
 * reference from going away underneath it — so a sessionless run is an anomaly
 * written outside dispatch. Without a session there is no scope and nobody who
 * could hold read there, so the rule denies by default: audit-grade org roles
 * keep `metadata`, everyone else gets `none`.
 *
 * `none` must be indistinguishable from a run that does not exist — that is
 * the caller's job at the API layer, same as the transcript read's refusal: a
 * distinct refusal would disclose that another person's run is there.
 */
export async function resolveRunAccess(options: ResolveRunAccessOptions): Promise<RunAccess> {
  const { db, orgId, principal, runId } = options;
  if (principal.orgId !== orgId || principal.kind === "agent") return { access: "none" };

  const run = await db.agentRun.findUnique({ where: { orgId_id: { orgId, id: runId } } });
  if (run === null) return { access: "none" };

  const session =
    run.sessionId === null
      ? null
      : await db.contextSession.findUnique({
          where: { orgId_id: { orgId, id: run.sessionId } },
        });
  if (session === null) {
    return (await holdsOrgAuditRole(principal, db))
      ? { access: "metadata", run, session: null, scope: null }
      : { access: "none" };
  }

  const scope = await db.scope.findUnique({
    where: { orgId_id: { orgId, id: session.scopeId } },
  });
  // The session's foreign key guarantees the scope row; a session that lost
  // its scope cannot exist, so this branch is unreachable and deny is the
  // only sane answer if it ever fires.
  if (scope === null) return { access: "none" };

  if (scope.kind === "personal") {
    if (scope.ownerId === principal.id) return { access: "full", run, session, scope };
    // Org roles deliberately do not inherit into personal scopes
    // (`effectiveRolesAtScope`), so the audit view is an explicit org-scope
    // role check, not a scope-read check.
    return (await holdsOrgAuditRole(principal, db))
      ? { access: "metadata", run, session, scope }
      : { access: "none" };
  }

  const roles = await effectiveRolesAtScope(principal, scope.id, db);
  if (roles.some((role) => roleAllowsCapability(role, "read"))) {
    return { access: "full", run, session, scope };
  }
  return { access: "none" };
}

/** Whether the principal's org-scope role is audit-grade: admin or owner. */
async function holdsOrgAuditRole(principal: AuthorizePrincipal, db: Database): Promise<boolean> {
  const orgScope = await db.scope.findFirst({
    where: { orgId: principal.orgId, kind: "org" },
    select: { id: true },
  });
  if (orgScope === null) return false;
  const roles = await effectiveRolesAtScope(principal, orgScope.id, db);
  return roles.some((role) => roleAllowsCapability(role, "read_audit"));
}
