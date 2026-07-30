import { createHash, randomBytes } from "node:crypto";

import type { ToolDef } from "@trema/harness";

import type {
  ApprovalMode,
  ContextSession,
  Prisma,
  Scope,
} from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { type ResolveLocationInput, resolveLocation } from "#server/services/bindings/index.js";
import { enabledCapabilityKeys } from "#server/services/capabilities/index.js";
import { capabilityToolDefs, sessionToolDefs } from "#server/services/dataplane/tools.js";
import { OrgAgentNotFoundError, requireOrgAgent } from "#server/services/org/index.js";
import { type PolicySnapshot, resolvePolicySnapshot } from "#server/services/policies/index.js";
import {
  type AssembledStanding,
  assembleStanding,
  type StandingCandidate,
} from "#server/services/sessions/standing.js";
import { getSurface } from "#server/services/surfaces/index.js";

export const SESSION_TOKEN_PREFIX = "trema_ses_";

/** Session tokens live fifteen minutes. Renewal restarts the clock. */
export const SESSION_TOKEN_TTL_MS = 15 * 60 * 1000;

export class SessionResolutionError extends Error {
  constructor(
    readonly code: "location_unbound" | "identity_unlinked" | "personal_scopes_disabled",
    message: string,
    readonly detail: Record<string, string> = {},
  ) {
    super(message);
    this.name = "SessionResolutionError";
  }
}

export class SessionValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SessionValidationError";
  }
}

export class SessionNotFoundError extends Error {
  constructor(message = "Session not found") {
    super(message);
    this.name = "SessionNotFoundError";
  }
}

export class SessionAuthenticationError extends Error {
  constructor() {
    super("Invalid session token");
    this.name = "SessionAuthenticationError";
  }
}

export class SessionExpiredError extends Error {
  readonly code = "session_expired";

  constructor() {
    super("Session token has expired");
    this.name = "SessionExpiredError";
  }
}

export class SessionClosedError extends Error {
  readonly code = "session_closed";

  constructor() {
    super("Session is already closed");
    this.name = "SessionClosedError";
  }
}

export function isSessionToken(token: string): boolean {
  return token.startsWith(SESSION_TOKEN_PREFIX) && token.length > SESSION_TOKEN_PREFIX.length;
}

export function hashSessionToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

function mintSessionToken(): string {
  return `${SESSION_TOKEN_PREFIX}${randomBytes(32).toString("base64url")}`;
}

export type SessionRequester = { externalUserId: string } | { principalId: string };

export interface OpenSessionInput {
  orgId: string;
  surface: string;
  locationRef: string;
  /**
   * Marks a one-to-one conversation with the agent, which resolves to a
   * personal scope. Surfaces with no bindable locations — web — need no flag:
   * every location on them is one, and the requesting principal names the owner.
   */
  dm?: boolean;
  threadRef?: string;
  requester?: SessionRequester;
  /**
   * The approval mode the requester chose for this thread. Defaults to `ask`;
   * the gate clamps it to the policy ceiling per call, so a choice above the
   * ceiling costs nothing and grants nothing.
   */
  approvalMode?: ApprovalMode;
  standingBudgetTokens?: number;
  now?: Date;
}

export interface OpenSessionResult {
  session: ContextSession;
  sessionToken: string;
  scopeChain: Scope[];
  standing: AssembledStanding;
  policySnapshot: PolicySnapshot;
  tools: ToolDef[];
}

interface ResolvedRequester {
  principal: { id: string; displayName: string } | null;
  externalRef: string | null;
}

async function resolveRequester(
  db: Database,
  orgId: string,
  surface: string,
  requester: SessionRequester | undefined,
): Promise<ResolvedRequester> {
  // A scheduled run has no requester at all.
  if (!requester) return { principal: null, externalRef: null };

  if ("principalId" in requester) {
    const principal = await db.principal.findFirst({
      where: { id: requester.principalId, orgId },
      select: { id: true, kind: true, displayName: true, deactivatedAt: true },
    });
    if (!principal) throw new SessionValidationError("Requester principal not found");
    if (principal.kind !== "human") {
      throw new SessionValidationError("Requester principal must be a human");
    }
    if (principal.deactivatedAt) {
      throw new SessionValidationError("Requester principal is deactivated");
    }
    return {
      principal: { id: principal.id, displayName: principal.displayName },
      externalRef: null,
    };
  }

  const link = await db.identityLink.findUnique({
    where: {
      orgId_surface_externalUserId: { orgId, surface, externalUserId: requester.externalUserId },
    },
    include: { principal: { select: { id: true, kind: true, displayName: true } } },
  });
  // An unlinked surface user may still trigger work in a shared scope; the raw
  // id is recorded so the audit trail names who asked.
  if (link?.principal.kind !== "human") {
    return { principal: null, externalRef: requester.externalUserId };
  }
  return {
    principal: { id: link.principal.id, displayName: link.principal.displayName },
    externalRef: requester.externalUserId,
  };
}

/**
 * Which one-to-one requester, if any, this location resolves through. A
 * surface whose locations cannot be bound has exactly one location per member —
 * their own chat with the agent — so every location on it is a one-to-one
 * conversation with the requesting principal, no `dm` flag and no identity link
 * needed. That is the web rule, read off the catalog rather than off a surface
 * id, and it stays pure lookup: web + requesting principal → that principal's
 * personal scope.
 *
 * It is a rule about a *known* surface. A surface the catalog has never heard
 * of is not "not bindable", it is not a surface: it falls through to ordinary
 * resolution, which finds no binding and reports `location_unbound`.
 */
function directRequester(
  input: OpenSessionInput,
  requester: ResolvedRequester,
): Pick<ResolveLocationInput, "dm"> {
  const surface = getSurface(input.surface);
  if (surface !== undefined && !surface.locationBindable) {
    if (!requester.principal) {
      throw new SessionValidationError(
        `A ${input.surface} session requires a requesting principal`,
      );
    }
    return { dm: { principal: requester.principal } };
  }

  const externalUserId =
    input.requester && "externalUserId" in input.requester
      ? input.requester.externalUserId
      : undefined;
  // A one-to-one conversation on a bindable surface resolves through the
  // sender's surface identity, so the harness must say who sent it.
  if (input.dm && !externalUserId) {
    throw new SessionValidationError("A direct-message session requires a surface requester");
  }
  return input.dm && externalUserId ? { dm: { externalUserId } } : {};
}

async function resolveScope(
  db: Database,
  input: OpenSessionInput,
  requester: ResolvedRequester,
): Promise<Scope> {
  const resolved = await resolveLocation(db, {
    orgId: input.orgId,
    surface: input.surface,
    locationRef: input.locationRef,
    ...directRequester(input, requester),
  });

  if (resolved.kind === "scope") return resolved.scope;
  // The surface id of the person who asked stays out of the log; the code and
  // the surface are what an operator acts on.
  if (resolved.kind === "unlinked") {
    log.warn("Session location unresolved", {
      code: "identity_unlinked",
      surface: resolved.surface,
    });
    throw new SessionResolutionError(
      "identity_unlinked",
      `Surface user ${resolved.externalUserId} on ${resolved.surface} is not linked to a person`,
      { surface: resolved.surface, externalUserId: resolved.externalUserId },
    );
  }
  if (resolved.kind === "personal_disabled") {
    log.warn("Session location unresolved", {
      code: "personal_scopes_disabled",
      surface: input.surface,
    });
    throw new SessionResolutionError(
      "personal_scopes_disabled",
      "Personal scopes are disabled for this organization",
      {},
    );
  }
  log.warn("Session location unresolved", {
    code: "location_unbound",
    surface: input.surface,
    locationRef: input.locationRef,
  });
  throw new SessionResolutionError(
    "location_unbound",
    `Location ${input.surface}:${input.locationRef} is not bound to a scope`,
    { surface: input.surface, locationRef: input.locationRef },
  );
}

async function resolveScopeChain(db: Database, orgId: string, scope: Scope): Promise<Scope[]> {
  if (scope.kind === "org") return [scope];
  const orgScope = await db.scope.findFirst({ where: { orgId, kind: "org" } });
  if (!orgScope) throw new SessionValidationError("Organization scope not found");
  return [orgScope, scope];
}

function validatePersonalRequester(scope: Scope, requester: ResolvedRequester): void {
  if (scope.kind !== "personal") return;
  if (!scope.ownerId) throw new SessionValidationError("Personal scope has no owner");
  if (!requester.principal) {
    throw new SessionValidationError("A personal session requires a linked requester");
  }
  if (requester.principal.id !== scope.ownerId) {
    throw new SessionValidationError("Only a personal scope's owner can open a session in it");
  }
}

async function loadStandingCandidates(
  db: Database,
  orgId: string,
  scopeChain: readonly string[],
): Promise<StandingCandidate[]> {
  return db.item.findMany({
    where: {
      orgId,
      scopeId: { in: [...scopeChain] },
      status: "active",
      disclosure: "standing",
    },
    select: {
      id: true,
      scopeId: true,
      kind: true,
      version: true,
      body: true,
      lastUsedAt: true,
      updatedAt: true,
    },
  });
}

/**
 * Hash the resolved snapshot contents. Two sessions that resolve the same
 * context share a hash, so a run can be traced to exactly what shaped it.
 */
export function hashSnapshot(input: {
  scopeChain: readonly string[];
  standing: AssembledStanding;
  policySnapshot: PolicySnapshot;
}): string {
  const canonical = JSON.stringify({
    scopeChain: input.scopeChain,
    instructions: input.standing.standing.instructions,
    items: input.standing.included,
    skillIndex: input.standing.standing.skillIndex,
    policySnapshot: input.policySnapshot,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

export async function openSession(
  db: Database,
  input: OpenSessionInput,
): Promise<OpenSessionResult> {
  const now = input.now ?? new Date();
  // The requester resolves first: a surface with no bindable locations resolves
  // its scope through that principal.
  const requester = await resolveRequester(db, input.orgId, input.surface, input.requester);
  const scope = await resolveScope(db, input, requester);
  validatePersonalRequester(scope, requester);
  const agentPrincipal = await requireOrgAgent(db, input.orgId).catch((error: unknown) => {
    if (error instanceof OrgAgentNotFoundError) {
      throw new SessionValidationError(error.message);
    }
    throw error;
  });
  const scopeChain = await resolveScopeChain(db, input.orgId, scope);
  const scopeChainIds = scopeChain.map(({ id }) => id);

  const candidates = await loadStandingCandidates(db, input.orgId, scopeChainIds);
  const standing = assembleStanding(candidates, {
    scopeChain: scopeChainIds,
    ...(input.standingBudgetTokens === undefined
      ? {}
      : { budgetTokens: input.standingBudgetTokens }),
  });
  const policySnapshot = await resolvePolicySnapshot(db, {
    orgId: input.orgId,
    scopeId: scope.id,
    scopeChain: scopeChainIds,
  });
  const capabilityKeys = await enabledCapabilityKeys(db, input.orgId);
  const tools = [...sessionToolDefs(), ...capabilityToolDefs(capabilityKeys)];
  const snapshotHash = hashSnapshot({
    scopeChain: scopeChainIds,
    standing,
    policySnapshot,
  });

  const sessionToken = mintSessionToken();
  const session = await db.$transaction(async (transaction) => {
    const created = await transaction.contextSession.create({
      data: {
        orgId: input.orgId,
        scopeId: scope.id,
        surface: input.surface,
        locationRef: input.locationRef,
        ...(input.threadRef ? { threadRef: input.threadRef } : {}),
        ...(input.approvalMode ? { approvalMode: input.approvalMode } : {}),
        scopeChain: scopeChainIds,
        agentPrincipalId: agentPrincipal.id,
        requesterPrincipalId: requester.principal?.id ?? null,
        requesterExternalRef: requester.externalRef,
        standing: {
          ...standing.standing,
          budgetTokens: standing.budgetTokens,
          usedTokens: standing.usedTokens,
          items: standing.included,
          overflowItemIds: standing.overflowItemIds,
        } as unknown as Prisma.InputJsonValue,
        policySnapshot: policySnapshot as unknown as Prisma.InputJsonValue,
        snapshotHash,
        tokenHash: hashSessionToken(sessionToken),
        expiresAt: new Date(now.getTime() + SESSION_TOKEN_TTL_MS),
      },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: agentPrincipal.id,
        action: "session.open",
        subject: created.id,
        payload: {
          scopeId: created.scopeId,
          surface: created.surface,
          requesterPrincipalId: created.requesterPrincipalId,
          requesterExternalRef: created.requesterExternalRef,
          snapshotHash: created.snapshotHash,
        },
      },
    });
    return created;
  });

  // Counts and the snapshot hash only: what the standing set says is context
  // content and never reaches a log line.
  log.info("Session opened", {
    sessionId: session.id,
    scopeId: scope.id,
    surface: input.surface,
    scopeChainLength: scopeChainIds.length,
    standingItems: standing.included.length,
    overflowItems: standing.overflowItemIds.length,
    standingTokens: standing.usedTokens,
    budgetTokens: standing.budgetTokens,
    snapshotHash,
  });
  if (standing.overflowItemIds.length > 0) {
    log.warn("Standing set cut by the token budget", {
      sessionId: session.id,
      overflowItems: standing.overflowItemIds.length,
      budgetTokens: standing.budgetTokens,
    });
  }

  return { session, sessionToken, scopeChain, standing, policySnapshot, tools };
}

/**
 * Resolve a session token to its session. Expiry and closure are left to the
 * caller: renewal refuses an expired session, while closing one still records
 * its usage.
 */
export async function authenticateSession(
  db: Database,
  token: string,
): Promise<ContextSession & { scope: Scope }> {
  if (!isSessionToken(token)) throw new SessionAuthenticationError();
  const session = await db.contextSession.findUnique({
    where: { tokenHash: hashSessionToken(token) },
    include: { scope: true },
  });
  if (!session) throw new SessionAuthenticationError();
  return session;
}

export function isSessionExpired(session: ContextSession, now = new Date()): boolean {
  return session.expiresAt.getTime() <= now.getTime();
}

export interface RenewSessionInput {
  orgId: string;
  sessionId: string;
  now?: Date;
}

export async function renewSession(
  db: Database,
  input: RenewSessionInput,
): Promise<ContextSession> {
  const now = input.now ?? new Date();
  const renewed = await db.$transaction(async (transaction) => {
    const session = await transaction.contextSession.findFirst({
      where: { id: input.sessionId, orgId: input.orgId },
    });
    if (!session) {
      log.warn("Session renewal rejected", { sessionId: input.sessionId, reason: "not_found" });
      throw new SessionNotFoundError();
    }
    if (session.closedAt) {
      log.warn("Session renewal rejected", { sessionId: session.id, reason: "closed" });
      throw new SessionClosedError();
    }
    if (isSessionExpired(session, now)) {
      log.warn("Session renewal rejected", { sessionId: session.id, reason: "expired" });
      throw new SessionExpiredError();
    }

    // Guarded like close, so a close committing after the read above cannot
    // be raced into extending a closed session's lifetime.
    const claimed = await transaction.contextSession.updateMany({
      where: { id: session.id, orgId: input.orgId, closedAt: null },
      data: { expiresAt: new Date(now.getTime() + SESSION_TOKEN_TTL_MS) },
    });
    if (claimed.count !== 1) {
      log.warn("Session renewal rejected", { sessionId: session.id, reason: "conflict" });
      throw new SessionClosedError();
    }
    const updated = await transaction.contextSession.findUniqueOrThrow({
      where: { orgId_id: { orgId: input.orgId, id: session.id } },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: session.agentPrincipalId,
        action: "session.renew",
        subject: session.id,
        payload: { expiresAt: updated.expiresAt.toISOString() },
      },
    });
    return updated;
  });
  // Logged after the transaction commits, so the line never claims a renewal
  // that rolled back.
  log.info("Session renewed", {
    sessionId: renewed.id,
    expiresAt: renewed.expiresAt.toISOString(),
  });
  return renewed;
}

export interface CloseSessionInput {
  orgId: string;
  sessionId: string;
  usage?: Record<string, number | undefined>;
  now?: Date;
}

export async function closeSession(
  db: Database,
  input: CloseSessionInput,
): Promise<ContextSession> {
  const now = input.now ?? new Date();
  const closed = await db.$transaction(async (transaction) => {
    const session = await transaction.contextSession.findFirst({
      where: { id: input.sessionId, orgId: input.orgId },
    });
    if (!session) {
      log.warn("Session close rejected", { sessionId: input.sessionId, reason: "not_found" });
      throw new SessionNotFoundError();
    }
    if (session.closedAt) {
      log.warn("Session close rejected", { sessionId: session.id, reason: "closed" });
      throw new SessionClosedError();
    }

    const claimed = await transaction.contextSession.updateMany({
      where: { id: session.id, orgId: input.orgId, closedAt: null },
      data: {
        closedAt: now,
        ...(input.usage ? { usage: input.usage as Prisma.InputJsonValue } : {}),
      },
    });
    if (claimed.count !== 1) {
      log.warn("Session close rejected", { sessionId: session.id, reason: "conflict" });
      throw new SessionClosedError();
    }

    const updated = await transaction.contextSession.findUniqueOrThrow({
      where: { orgId_id: { orgId: input.orgId, id: session.id } },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: session.agentPrincipalId,
        action: "session.close",
        subject: session.id,
        payload: {
          closedAt: now.toISOString(),
          usage: (input.usage ?? null) as Prisma.InputJsonValue,
        },
      },
    });
    return updated;
  });
  // Logged after the transaction commits, so the line never claims a close
  // that rolled back.
  log.info("Session closed", {
    sessionId: closed.id,
    usageReported: input.usage !== undefined,
  });
  return closed;
}
