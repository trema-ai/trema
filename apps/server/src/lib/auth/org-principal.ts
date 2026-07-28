import type { Org, Principal } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { bindLogger, log } from "#server/lib/logger/index.js";

/** The slice of a better-auth session the org-principal resolution reads. */
export interface AuthenticatedSession {
  session: { activeOrgId?: string | null | undefined };
  user: { id: string };
}

/**
 * The resolution verdict. A failure carries the message the caller surfaces;
 * every failure is a forbidden-grade refusal — the session itself was already
 * proven by whoever fetched it.
 */
export type OrgPrincipalResolution =
  | { ok: true; org: Org; principal: Principal }
  | { ok: false; message: string };

/**
 * Resolves an authenticated browser session to its active org and the
 * caller's principal there: active org id → org row → principal by
 * `orgId_authId` → deactivation check. The one resolution both the oRPC
 * `orgScoped` builder and the raw SSE route share, so a cookie means the
 * same caller everywhere.
 *
 * On success the org and principal ids are bound to the request logger.
 */
export async function resolveOrgPrincipal(
  db: Database,
  session: AuthenticatedSession,
): Promise<OrgPrincipalResolution> {
  const { activeOrgId } = session.session;

  if (!activeOrgId) {
    return { ok: false, message: "No active organization" };
  }

  const [org, principal] = await Promise.all([
    db.org.findUnique({
      where: { id: activeOrgId },
    }),
    db.principal.findUnique({
      where: {
        orgId_authId: {
          orgId: activeOrgId,
          authId: session.user.id,
        },
      },
    }),
  ]);

  if (!org) {
    log.warn("Active organization not found", { orgId: activeOrgId });
    return { ok: false, message: "Active organization not found" };
  }

  if (!principal) {
    log.warn("Principal not found in active organization", { orgId: activeOrgId });
    return { ok: false, message: "Principal not found in active organization" };
  }

  if (principal.deactivatedAt) {
    log.warn("Principal is deactivated", { orgId: org.id, principalId: principal.id });
    return { ok: false, message: "Principal is deactivated" };
  }

  bindLogger({ orgId: org.id, principalId: principal.id });

  return { ok: true, org, principal };
}
