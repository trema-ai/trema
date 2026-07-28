import { createHash } from "node:crypto";

import type {
  Approval,
  ApprovalMode,
  ApprovalStatus,
  ContextSession,
  Item,
  Prisma,
  Role,
  ScopeKind,
  ToolGrant,
} from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type AuthorizePrincipal,
  effectiveRolesAtScope,
} from "#server/services/authorize/index.js";
import { activateItem, getItem } from "#server/services/items/index.js";
import {
  type ApprovalRouting,
  type PolicyRow,
  resolveApprovalRouting,
  resolveScopePolicies,
} from "#server/services/policies/index.js";

/**
 * Activating a `proposed` rule, instruction, or skill is an approval like any
 * other tool call — same approver resolution, same audit trail, same rendering
 * path. One concept, not two.
 */
export const ACTIVATE_ITEM_TOOL_KEY = "context:activate_item";

/** How long an approval waits for a human before it expires visibly. */
export const APPROVAL_TTL_MS = 24 * 60 * 60 * 1000;

/** How often the sweep re-surfaces an approval that is still waiting. */
export const APPROVAL_NUDGE_INTERVAL_MS = 60 * 60 * 1000;

/** How many approvals one listing or one sweep pass handles. */
export const APPROVAL_PAGE_SIZE = 50;

/**
 * How many rows one listing reads before it stops looking.
 *
 * Resolvability is a per-scope role question the database cannot fully answer,
 * so a listing filters rows it has already read. It therefore reads in pages
 * until the caller's limit is filled — and stops here, so a principal who may
 * resolve nothing costs a bounded scan rather than the whole table.
 */
export const APPROVAL_SCAN_LIMIT = 10 * APPROVAL_PAGE_SIZE;

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

export class ApprovalNotFoundError extends Error {
  constructor(message = "Approval not found") {
    super(message);
    this.name = "ApprovalNotFoundError";
  }
}

export class ApprovalValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ApprovalValidationError";
  }
}

/** The approval is not in a state that allows what the caller asked for. */
export class ApprovalStateError extends Error {
  constructor(
    readonly code: "not_pending" | "expired" | "not_approved" | "already_executed",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalStateError";
  }
}

/** The principal may not resolve this approval. */
export class ApprovalApproverError extends Error {
  constructor(
    readonly code:
      | "not_a_human"
      | "deactivated"
      | "requester_self_approval"
      | "role_required"
      | "unknown_principal",
    message: string,
  ) {
    super(message);
    this.name = "ApprovalApproverError";
  }
}

/** The call about to run is not the call that was approved. */
export class ApprovalArgsMismatchError extends Error {
  readonly code = "args_changed";

  constructor(
    message = "The arguments changed since the approval was granted; a changed call needs a new approval",
  ) {
    super(message);
    this.name = "ApprovalArgsMismatchError";
  }
}

function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.keys(value as Record<string, unknown>)
        .sort()
        .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
    );
  }
  return value;
}

/**
 * Fingerprint one call's arguments.
 *
 * Key order is not part of the call, so the hash is taken over a canonical form
 * with every object's keys sorted. Everything else is: a changed value, an
 * added field, a reordered array is a different call, and a different call
 * needs its own approval.
 */
export function hashApprovalArgs(args: unknown): string {
  return createHash("sha256")
    .update(JSON.stringify(canonical(args) ?? null), "utf8")
    .digest("hex");
}

/**
 * The routing an interrupt records: who may resolve it, pinned from the
 * session's snapshot rows — never live policy. The most specific applicable
 * row supplies it (the connector's own row before a scope-wide one, a narrower
 * scope before a wider one), and the built-in defaults when nothing wrote one.
 */
export function routingForSession(
  session: SessionWithScope,
  connectorKey?: string,
): ApprovalRouting {
  const snapshot = session.policySnapshot as { rows?: PolicyRow[] } | null;
  if (!snapshot) {
    throw new ApprovalValidationError("Session carries no policy snapshot");
  }
  return resolveApprovalRouting({
    rows: snapshot.rows ?? [],
    scopeChain: session.scopeChain,
    scopeKind: session.scope.kind,
    ...(connectorKey === undefined ? {} : { connectorKey }),
  });
}

export type ApprovalResolutionCheck =
  | { ok: true }
  | { ok: false; reason: "requester_self_approval" | "role_required" };

/**
 * May this person resolve this approval?
 *
 * The rule the approval carries is the one pinned when it was asked, so the
 * answer never changes under a policy edit. Two clauses, in order: the person
 * who asked is refused unless the rule lets a requester wave their own call
 * through — that is the separation of duties the destructive default exists
 * for, and holding an approver role does not buy past it. Anyone else needs one
 * of the rule's roles at the approval's scope.
 */
export function canResolveApproval(input: {
  approval: Pick<Approval, "approverRoles" | "allowRequesterApproval" | "requesterPrincipalId">;
  approverPrincipalId: string;
  /** The approver's effective roles at the approval's scope. */
  approverRoles: readonly Role[];
}): ApprovalResolutionCheck {
  if (input.approval.requesterPrincipalId === input.approverPrincipalId) {
    return input.approval.allowRequesterApproval
      ? { ok: true }
      : { ok: false, reason: "requester_self_approval" };
  }
  const holdsRole = input.approval.approverRoles.some((role) => input.approverRoles.includes(role));
  return holdsRole ? { ok: true } : { ok: false, reason: "role_required" };
}

/**
 * The roles that count when deciding who may resolve an approval at a scope.
 *
 * One addition to the control-plane roles: in their own personal scope the
 * owner also satisfies an `owner` approver role. The two readings of "owner"
 * are deliberately different. For capabilities it is an organization role, and
 * owning a personal scope must not confer org settings or billing. For an
 * approval it names the person a rule is about, and the personal defaults in
 * `services/policies` name `owner` as the approver of a destructive call in a
 * personal scope — that approver is the person whose scope it is.
 */
async function approverRolesAtScope(
  db: Database,
  principal: AuthorizePrincipal,
  scopeId: string,
): Promise<Role[]> {
  const roles = await effectiveRolesAtScope(principal, scopeId, db);
  const scope = await db.scope.findFirst({
    where: { id: scopeId, orgId: principal.orgId },
    select: { kind: true, ownerId: true },
  });
  if (scope?.kind === "personal" && scope.ownerId === principal.id) roles.push("owner");
  return roles;
}

type SessionWithScope = ContextSession & { scope: { id: string; kind: ScopeKind } };

async function requireOpenSession(
  db: Database,
  orgId: string,
  sessionId: string,
): Promise<SessionWithScope> {
  const session = await db.contextSession.findFirst({
    where: { id: sessionId, orgId },
    include: { scope: { select: { id: true, kind: true } } },
  });
  if (!session) throw new ApprovalValidationError("Session not found");
  if (session.closedAt) throw new ApprovalValidationError("Session is already closed");
  return session;
}

export async function requireApproval(
  db: Database,
  orgId: string,
  approvalId: string,
): Promise<Approval> {
  const approval = await db.approval.findFirst({ where: { id: approvalId, orgId } });
  if (!approval) throw new ApprovalNotFoundError();
  return approval;
}

export interface RequestApprovalInput {
  orgId: string;
  sessionId: string;
  toolKey: string;
  /** The approval mode the call paused under: `ask`, or a `delegated` escalation. */
  mode: ApprovalMode;
  /** The classifier's one-line reason for pausing a delegated-mode call. */
  escalationReason?: string;
  /** The connector the call reaches; routes the interrupt via its policy rows. */
  connectorKey?: string;
  /** The call's arguments. Recorded verbatim; the approval covers these alone. */
  args: unknown;
  /** The model's one-line justification, rendered to the approver. */
  reason: string;
  /**
   * What the approved call will run against, in the caller's own vocabulary —
   * recorded here and handed back at claim time so the caller can compare it
   * with what a re-resolution now says. This service records it and never
   * reads it: what counts as "the same thing to run against" is a question
   * only the caller can answer.
   */
  executionBinding?: Record<string, unknown>;
  ttlMs?: number;
  now?: Date;
}

export interface ApprovalRequest {
  approval: Approval;
  routing: ApprovalRouting;
}

/**
 * Record the interrupt that pauses one call — the gate already decided the
 * pause; this records who may end it.
 *
 * The harness renders the prompt wherever the conversation lives, and the
 * control-plane UI is always an alternative surface. Asking twice for the same
 * call while the first ask is still pending returns that same approval: a
 * resumed run repeating its tool call is one decision for a person, not two.
 * That holds under concurrency because the database holds it: the partial
 * unique index `Approval_one_pending_per_session_call` lets exactly one
 * pending row exist per call, and the loser of the race reads the winner's
 * row.
 */
export async function requestApproval(
  db: Database,
  input: RequestApprovalInput,
): Promise<ApprovalRequest> {
  const now = input.now ?? new Date();
  const session = await requireOpenSession(db, input.orgId, input.sessionId);
  const routing = routingForSession(session, input.connectorKey);

  const reason = input.reason.trim();
  if (!reason) throw new ApprovalValidationError("An approval needs a one-line reason");
  const argsHash = hashApprovalArgs(input.args);

  const pendingForCall = {
    orgId: input.orgId,
    sessionId: session.id,
    toolKey: input.toolKey,
    argsHash,
    status: "pending",
  } as const;

  const pending = await db.approval.findFirst({
    where: { ...pendingForCall, expiresAt: { gt: now } },
    orderBy: { createdAt: "desc" },
  });
  if (pending) {
    log.debug("Approval already pending", { approvalId: pending.id, sessionId: session.id });
    return { approval: pending, routing };
  }

  const create = () =>
    db.$transaction(async (transaction) => {
      const created = await transaction.approval.create({
        data: {
          orgId: input.orgId,
          sessionId: session.id,
          scopeId: session.scopeId,
          toolKey: input.toolKey,
          argsJson: (input.args ?? null) as Prisma.InputJsonValue,
          argsHash,
          reason,
          mode: input.mode,
          ...(input.escalationReason ? { escalationReason: input.escalationReason } : {}),
          approverRoles: routing.approverRoles,
          allowRequesterApproval: routing.allowRequesterApproval,
          requesterPrincipalId: session.requesterPrincipalId,
          requesterExternalRef: session.requesterExternalRef,
          ...(input.executionBinding
            ? { executionBinding: input.executionBinding as Prisma.InputJsonObject }
            : {}),
          expiresAt: new Date(now.getTime() + (input.ttlMs ?? APPROVAL_TTL_MS)),
        },
      });
      // The arguments and the model's reason stay in the row; the audit entry
      // carries the fingerprint, which is what an auditor matches an execution
      // against.
      await transaction.auditLog.create({
        data: {
          orgId: input.orgId,
          actorPrincipalId: session.actingPrincipalId,
          action: "approval.request",
          subject: created.id,
          payload: {
            sessionId: session.id,
            scopeId: created.scopeId,
            toolKey: created.toolKey,
            mode: created.mode,
            argsHash: created.argsHash,
            approverRoles: created.approverRoles,
            allowRequesterApproval: created.allowRequesterApproval,
            requesterPrincipalId: created.requesterPrincipalId,
            expiresAt: created.expiresAt.toISOString(),
          },
        },
      });
      return created;
    });

  let approval: Approval;
  try {
    approval = await create();
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    // Someone asked for the same call at the same moment, or an earlier ask is
    // still `pending` past its deadline because no sweep has reached it. The
    // first is another executor's row to return; the second is a row this call
    // expires itself before asking again, so a stale ask cannot block a live
    // one. A second violation is a genuine race with a third writer, and its
    // row is the answer.
    const existing = await db.approval.findFirst({
      where: pendingForCall,
      orderBy: { createdAt: "desc" },
    });
    if (!existing) throw error;
    if (existing.expiresAt.getTime() > now.getTime()) {
      log.debug("Approval already pending", { approvalId: existing.id, sessionId: session.id });
      return { approval: existing, routing };
    }
    await expireApproval(db, existing);
    approval = await create().catch(async (retried: unknown) => {
      if (!isUniqueViolation(retried)) throw retried;
      return db.approval.findFirstOrThrow({
        where: { ...pendingForCall, expiresAt: { gt: now } },
        orderBy: { createdAt: "desc" },
      });
    });
  }

  log.info("Approval requested", {
    approvalId: approval.id,
    sessionId: session.id,
    scopeId: approval.scopeId,
    toolKey: approval.toolKey,
    mode: approval.mode,
    expiresAt: approval.expiresAt.toISOString(),
  });
  return { approval, routing };
}

export interface RequestItemActivationInput {
  orgId: string;
  sessionId: string;
  itemId: string;
  reason: string;
  ttlMs?: number;
  now?: Date;
}

/**
 * Ask a person to activate a `proposed` item.
 *
 * The item has to sit at the session's own scope, for the same reason a run
 * writes only there: promoting a wider scope's proposal is that scope's call.
 * Activation itself happens when the approval is approved, through the ordinary
 * item lifecycle transition with the approving human as the actor — a human
 * activating from the control-plane UI takes exactly the same path, because the
 * UI is an approval surface and not a second mechanism.
 */
export async function requestItemActivation(
  db: Database,
  input: RequestItemActivationInput,
): Promise<Approval> {
  const session = await requireOpenSession(db, input.orgId, input.sessionId);
  const item = await db.item.findFirst({
    where: { id: input.itemId, orgId: input.orgId, scopeId: session.scopeId },
    select: { id: true, status: true },
  });
  if (!item) throw new ApprovalValidationError("Item not found at the session's scope");
  if (item.status !== "proposed") {
    throw new ApprovalValidationError(
      `Only a proposed item is activated through an approval; this one is ${item.status}`,
    );
  }

  const requested = await requestApproval(db, {
    orgId: input.orgId,
    sessionId: input.sessionId,
    toolKey: ACTIVATE_ITEM_TOOL_KEY,
    // An item lands `proposed` precisely because a person has to confirm it,
    // so this interrupt exists in every mode; the scope's routing rows decide
    // who confirms.
    mode: "ask",
    args: { itemId: item.id },
    reason: input.reason,
    ...(input.ttlMs === undefined ? {} : { ttlMs: input.ttlMs }),
    ...(input.now === undefined ? {} : { now: input.now }),
  });
  return requested.approval;
}

/**
 * The person on the other side of an approval. Only a person resolves one: an
 * agent holds no control-plane role by construction, so this is a guard against
 * a caller, not against a role.
 */
async function requireApprover(
  db: Database,
  orgId: string,
  approverPrincipalId: string,
): Promise<AuthorizePrincipal> {
  const approver = await db.principal.findFirst({
    where: { id: approverPrincipalId, orgId },
    select: { id: true, kind: true, deactivatedAt: true },
  });
  if (!approver) {
    throw new ApprovalApproverError("unknown_principal", "Approver principal not found");
  }
  if (approver.kind !== "human") {
    throw new ApprovalApproverError("not_a_human", "Only a person can resolve an approval");
  }
  if (approver.deactivatedAt) {
    throw new ApprovalApproverError("deactivated", "Approver principal is deactivated");
  }
  return { id: approver.id, orgId, kind: approver.kind };
}

async function assertResolvable(
  db: Database,
  approval: Approval,
  approverPrincipalId: string,
  now: Date,
): Promise<void> {
  const approver = await requireApprover(db, approval.orgId, approverPrincipalId);

  if (approval.status !== "pending") {
    throw new ApprovalStateError("not_pending", `Approval is already ${approval.status}`);
  }
  if (approval.expiresAt.getTime() <= now.getTime()) {
    // The sweep expires approvals on a schedule, but a resolution arriving late
    // must not slip through the gap between firings.
    await expireApproval(db, approval);
    throw new ApprovalStateError("expired", "Approval has expired; the call needs a new one");
  }

  const roles = await approverRolesAtScope(db, approver, approval.scopeId);
  const check = canResolveApproval({
    approval,
    approverPrincipalId: approver.id,
    approverRoles: roles,
  });
  if (!check.ok) {
    log.warn("Approval resolution refused", {
      approvalId: approval.id,
      scopeId: approval.scopeId,
      reason: check.reason,
    });
    throw new ApprovalApproverError(
      check.reason,
      check.reason === "requester_self_approval"
        ? "The person who asked for this call may not approve it"
        : "You do not hold an approver role for this approval",
    );
  }
}

/**
 * Record one resolution — and, where the yes promised more than itself,
 * whatever else has to land with it.
 *
 * `alsoWithin` runs inside the same transaction as the status change, against
 * the resolved row. A resolution that promises a wider consent has to commit
 * that consent with it: the status change is single-shot, so an approval that
 * reached `approved` with the promise unkept can never be re-approved to keep
 * it, and the person's `run` or `always` yes would be lost with nothing left
 * to show for it. Failing the callback rolls the yes back and leaves the
 * approval pending, which is a decision that can be made again.
 */
async function recordResolution(
  db: Database,
  approval: Approval,
  status: Extract<ApprovalStatus, "approved" | "denied">,
  approverPrincipalId: string,
  now: Date,
  alsoWithin?: (transaction: Prisma.TransactionClient, resolved: Approval) => Promise<void>,
): Promise<Approval> {
  const resolved = await db.$transaction(async (transaction) => {
    // The status guard is what makes resolution single-shot: two approvers
    // clicking at once leave one winner and one clear conflict.
    const claimed = await transaction.approval.updateMany({
      where: { id: approval.id, orgId: approval.orgId, status: "pending" },
      data: { status, resolvedById: approverPrincipalId, resolvedAt: now },
    });
    if (claimed.count !== 1) {
      const current = await transaction.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: approval.orgId, id: approval.id } },
        select: { status: true },
      });
      throw new ApprovalStateError("not_pending", `Approval is already ${current.status}`);
    }
    const updated = await transaction.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: approval.orgId, id: approval.id } },
    });
    await transaction.auditLog.create({
      data: {
        orgId: approval.orgId,
        actorPrincipalId: approverPrincipalId,
        action: `approval.${status}`,
        subject: approval.id,
        payload: {
          sessionId: updated.sessionId,
          scopeId: updated.scopeId,
          toolKey: updated.toolKey,
          mode: updated.mode,
          argsHash: updated.argsHash,
          requesterPrincipalId: updated.requesterPrincipalId,
        },
      },
    });
    await alsoWithin?.(transaction, updated);
    return updated;
  });

  log.info("Approval resolved", {
    approvalId: resolved.id,
    sessionId: resolved.sessionId,
    toolKey: resolved.toolKey,
    status: resolved.status,
  });
  return resolved;
}

/**
 * How wide a yes is. `once` covers the recorded arguments and nothing else;
 * `run` covers the tool for the rest of the thread; `always` is a standing,
 * admin-visible exemption for the requester at the approval's scope. The two
 * wider variants mint a {@link ToolGrant} — the coarser consent is the
 * human's explicit choice, stated on the card, never a default.
 */
export type ApprovalGrantScope = "once" | "run" | "always";

export interface ResolveApprovalInput {
  orgId: string;
  approvalId: string;
  approverPrincipalId: string;
  grantScope?: ApprovalGrantScope;
  now?: Date;
}

export interface ApprovalResolution {
  approval: Approval;
  /** The item an activation approval activated, when the approval carried one. */
  activatedItemId?: string;
}

/**
 * The item a `context:activate_item` approval names. Recorded arguments are
 * whatever JSON was stored, so this reads them defensively: `null`, a list, or
 * a row missing the field is an approval with nothing to activate, not a crash.
 */
function activationItemId(args: Prisma.JsonValue): string | undefined {
  if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
  const itemId = (args as Record<string, unknown>).itemId;
  return typeof itemId === "string" ? itemId : undefined;
}

/**
 * Retire the asks that a completed activation has answered.
 *
 * A pending activation approval is a question about an item that is not on
 * yet, so once it is on, every other ask about it is moot. There can be
 * others: re-ask dedup is per session by construction, so two sessions can
 * each hold a pending ask for the same item, and leaving them would have the
 * sweep nudging people about a decision already made. They end `expired` —
 * nothing in the status vocabulary fits a question that stopped needing an
 * answer, and the vocabulary is the permissions spec's, not this function's to
 * widen — and the audit entry records which activation answered them.
 */
async function supersedeActivationApprovals(
  db: Database,
  input: { orgId: string; scopeId: string; itemId: string; exceptApprovalId?: string },
): Promise<number> {
  const stale = await db.approval.findMany({
    where: {
      orgId: input.orgId,
      scopeId: input.scopeId,
      toolKey: ACTIVATE_ITEM_TOOL_KEY,
      argsHash: hashApprovalArgs({ itemId: input.itemId }),
      status: "pending",
      ...(input.exceptApprovalId ? { id: { not: input.exceptApprovalId } } : {}),
    },
  });

  let superseded = 0;
  for (const approval of stale) {
    // The compare-and-swap the sweep expires with: a row someone else resolved
    // in the meantime is theirs, and is left alone.
    const claimed = await db.approval.updateMany({
      where: { id: approval.id, orgId: approval.orgId, status: "pending" },
      data: { status: "expired" },
    });
    if (claimed.count !== 1) continue;
    await db.auditLog.create({
      data: {
        orgId: approval.orgId,
        // Nobody answered this one. The activation did.
        actorPrincipalId: null,
        action: "approval.superseded",
        subject: approval.id,
        payload: {
          sessionId: approval.sessionId,
          scopeId: approval.scopeId,
          toolKey: approval.toolKey,
          mode: approval.mode,
          itemId: input.itemId,
          ...(input.exceptApprovalId ? { supersededBy: input.exceptApprovalId } : {}),
        },
      },
    });
    superseded += 1;
  }

  if (superseded > 0) {
    log.info("Activation approvals superseded", {
      itemId: input.itemId,
      scopeId: input.scopeId,
      superseded,
    });
  }
  return superseded;
}

/**
 * Mint the wider consent an approval's `run` or `always` variant promises.
 *
 * A `run` grant names the approval's session and dies with it; an `always`
 * grant names no session and stands at the approval's scope until revoked.
 * Both name the requester where one is linked — for `always`, the caller has
 * already required one.
 *
 * It writes through the caller's transaction rather than opening its own,
 * because the yes and the consent it promised are one fact: see
 * {@link recordResolution}.
 */
async function mintToolGrant(
  transaction: Prisma.TransactionClient,
  approval: Approval,
  grantScope: Extract<ApprovalGrantScope, "run" | "always">,
  approverPrincipalId: string,
): Promise<ToolGrant> {
  const grant = await transaction.toolGrant.create({
    data: {
      orgId: approval.orgId,
      scopeId: approval.scopeId,
      toolKey: approval.toolKey,
      ...(grantScope === "run" ? { sessionId: approval.sessionId } : {}),
      ...(approval.requesterPrincipalId
        ? { requesterPrincipalId: approval.requesterPrincipalId }
        : {}),
      sourceApprovalId: approval.id,
      createdById: approverPrincipalId,
    },
  });
  await transaction.auditLog.create({
    data: {
      orgId: approval.orgId,
      actorPrincipalId: approverPrincipalId,
      action: "tool_grant.minted",
      subject: grant.id,
      payload: {
        scopeId: grant.scopeId,
        toolKey: grant.toolKey,
        sessionId: grant.sessionId,
        requesterPrincipalId: grant.requesterPrincipalId,
        sourceApprovalId: approval.id,
        grantScope,
      },
    },
  });
  return grant;
}

export interface FindToolGrantInput {
  orgId: string;
  toolKey: string;
  sessionId: string;
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
  requesterPrincipalId: string | null;
}

/**
 * The grant that lets one call skip the gate: a thread grant minted in this
 * very session, or a standing grant for this requester at a scope in the
 * chain. A session with no linked requester matches thread grants only — a
 * standing grant always names the person it covers.
 */
export async function findToolGrant(
  db: Database,
  input: FindToolGrantInput,
): Promise<ToolGrant | null> {
  return db.toolGrant.findFirst({
    where: {
      orgId: input.orgId,
      toolKey: input.toolKey,
      revokedAt: null,
      OR: [
        { sessionId: input.sessionId },
        ...(input.requesterPrincipalId
          ? [
              {
                sessionId: null,
                scopeId: { in: [...input.scopeChain] },
                requesterPrincipalId: input.requesterPrincipalId,
              },
            ]
          : []),
      ],
    },
    orderBy: { createdAt: "asc" },
  });
}

/**
 * Approve a pending call.
 *
 * Approving a `context:activate_item` approval also performs it: activation is
 * a database transition this process owns, so leaving it to a later executor
 * would put a second step between a person's yes and the thing they said yes
 * to. Every other tool key is executed by whoever asked, under
 * `claimApprovalExecution`.
 */
export async function approveApproval(
  db: Database,
  input: ResolveApprovalInput,
): Promise<ApprovalResolution> {
  const now = input.now ?? new Date();
  const approval = await requireApproval(db, input.orgId, input.approvalId);
  const grantScope = input.grantScope ?? "once";
  if (grantScope !== "once") {
    // Validated before the resolution is recorded, so a refused variant leaves
    // the approval pending for a plain yes rather than half-resolved.
    if (approval.toolKey === ACTIVATE_ITEM_TOOL_KEY) {
      throw new ApprovalValidationError("Item activation has no wider approval variant");
    }
    if (grantScope === "always" && !approval.requesterPrincipalId) {
      throw new ApprovalValidationError(
        "A standing grant names the requester it covers, and this approval has no linked requester",
      );
    }
  }
  await assertResolvable(db, approval, input.approverPrincipalId, now);
  if (approval.toolKey !== ACTIVATE_ITEM_TOOL_KEY) {
    // The wider yes and the grant that carries it are recorded together, so a
    // mint that fails leaves the approval pending rather than `approved` with
    // the consent the approver asked for silently missing.
    let minted: ToolGrant | undefined;
    const resolved = await recordResolution(
      db,
      approval,
      "approved",
      input.approverPrincipalId,
      now,
      grantScope === "once"
        ? undefined
        : async (transaction, approved) => {
            minted = await mintToolGrant(
              transaction,
              approved,
              grantScope,
              input.approverPrincipalId,
            );
          },
    );
    if (minted) {
      log.info("Tool grant minted", {
        grantId: minted.id,
        toolKey: minted.toolKey,
        scopeId: minted.scopeId,
        grantScope,
      });
    }
    return { approval: resolved };
  }

  // Read the item out before anything is written. An activation approval whose
  // arguments name no item has no call to perform, and recording the decision
  // first would strand the row: `approved`, never executed, and no longer
  // pending for anyone to resolve. Refused while pending, it can still expire
  // or be denied like any other.
  const itemId = activationItemId(approval.argsJson);
  if (itemId === undefined) {
    log.warn("Activation approval names no item", { approvalId: approval.id });
    throw new ApprovalValidationError("Activation approval carries no item");
  }

  const resolved = await recordResolution(db, approval, "approved", input.approverPrincipalId, now);
  // The one execution whose arguments come from the approval row rather than
  // from a caller: activation is performed here, from what the approver saw, so
  // there is no payload in flight for exact-args binding to disagree with.
  const claimed = await claimApprovalExecution(db, {
    orgId: input.orgId,
    approvalId: resolved.id,
    args: resolved.argsJson,
    now,
  });
  try {
    await activateItem(db, {
      orgId: input.orgId,
      actorPrincipalId: input.approverPrincipalId,
      itemId,
    });
  } catch (error) {
    // The activation is one transaction, so a failure here provably did not
    // happen: releasing the claim leaves the approval executable rather than
    // burning it on a call that never ran. An out-of-process executor has no
    // such proof and keeps its claim.
    await releaseApprovalExecution(db, { orgId: input.orgId, approvalId: resolved.id });
    throw error;
  }
  await supersedeActivationApprovals(db, {
    orgId: input.orgId,
    scopeId: resolved.scopeId,
    itemId,
    exceptApprovalId: resolved.id,
  });
  return { approval: claimed, activatedItemId: itemId };
}

/** Deny a pending call. The run reads the denial as the tool's result. */
export async function denyApproval(db: Database, input: ResolveApprovalInput): Promise<Approval> {
  const now = input.now ?? new Date();
  const approval = await requireApproval(db, input.orgId, input.approvalId);
  await assertResolvable(db, approval, input.approverPrincipalId, now);
  return recordResolution(db, approval, "denied", input.approverPrincipalId, now);
}

type ProposedItem = { id: string; scopeId: string; sourceSessionId: string | null };
type ActivationScope = { id: string; kind: ScopeKind; ownerId: string | null };

/**
 * Who counts as having asked for an activation nobody filed an approval for.
 *
 * The proposal came out of a run, so the person that run was acting for is the
 * requester — that is the same person `requestApproval` would have recorded. A
 * personal scope with no such link falls back to its owner, because a proposal
 * in someone's personal scope is a proposal made for them.
 */
async function activationRequesterId(
  db: Database,
  orgId: string,
  item: ProposedItem,
  scope: ActivationScope,
): Promise<string | null> {
  if (item.sourceSessionId) {
    const session = await db.contextSession.findFirst({
      where: { id: item.sourceSessionId, orgId },
      select: { requesterPrincipalId: true },
    });
    if (session?.requesterPrincipalId) return session.requesterPrincipalId;
  }
  return scope.kind === "personal" ? scope.ownerId : null;
}

/**
 * May this person turn a proposed item on themselves?
 *
 * Activating a proposal is the approval, wherever it is done from, so the same
 * rule decides it: the scope's approvers for the write class, and the person
 * the proposal was made for only where that rule lets a requester confirm their
 * own. Holding `write_items` is what lets someone reach the transition; it is
 * not what lets them make the decision.
 *
 * One deliberate difference from resolving a recorded approval: there is no
 * pinned snapshot here, because nobody asked. The policy that governs is the
 * scope's policy as it stands now — a decision made now is made under today's
 * rule, not under the rule some session pinned.
 */
async function assertMayConfirmActivation(
  db: Database,
  input: { orgId: string; item: ProposedItem; approverPrincipalId: string },
): Promise<void> {
  const approver = await requireApprover(db, input.orgId, input.approverPrincipalId);
  const scope = await db.scope.findFirst({
    where: { id: input.item.scopeId, orgId: input.orgId },
    select: { id: true, kind: true, ownerId: true },
  });
  if (!scope) throw new ApprovalValidationError("Item scope not found");

  const { routing } = await resolveScopePolicies(db, {
    orgId: input.orgId,
    scopeId: scope.id,
  });
  const check = canResolveApproval({
    approval: {
      approverRoles: routing.approverRoles,
      allowRequesterApproval: routing.allowRequesterApproval,
      requesterPrincipalId: await activationRequesterId(db, input.orgId, input.item, scope),
    },
    approverPrincipalId: approver.id,
    approverRoles: await approverRolesAtScope(db, approver, scope.id),
  });
  if (!check.ok) {
    log.warn("Item activation refused", {
      itemId: input.item.id,
      scopeId: scope.id,
      reason: check.reason,
    });
    throw new ApprovalApproverError(
      check.reason,
      check.reason === "requester_self_approval"
        ? "The person this item was proposed for may not confirm it alone"
        : "You do not hold a role that may confirm a proposed item in this scope",
    );
  }
}

export interface ConfirmItemActivationInput {
  orgId: string;
  itemId: string;
  approverPrincipalId: string;
  now?: Date;
}

export interface ItemActivationConfirmation {
  item: Item;
  /** The waiting approval this confirmation resolved, when one was waiting. */
  approval?: Approval;
}

/**
 * Activate an item from the control plane.
 *
 * The control-plane UI is an alternative approval surface, never a way around
 * one: a person turning a proposal on here is performing the approval, so they
 * face the same approver rule the approve endpoint would apply. Where a run
 * already asked, this resolves that approval rather than leaving it waiting for
 * a decision that has been made — one item, one decision, one audit trail.
 */
export async function confirmItemActivation(
  db: Database,
  input: ConfirmItemActivationInput,
): Promise<ItemActivationConfirmation> {
  const now = input.now ?? new Date();
  const item = await db.item.findFirst({
    where: { id: input.itemId, orgId: input.orgId },
    select: { id: true, scopeId: true, status: true, sourceSessionId: true },
  });
  // A missing item, or one that is not `proposed`, is the item service's answer
  // to give: there is no confirm step where there is no proposal, and the
  // lifecycle table refuses the rest with its own error.
  if (item?.status !== "proposed") {
    return {
      item: await activateItem(db, {
        orgId: input.orgId,
        actorPrincipalId: input.approverPrincipalId,
        itemId: input.itemId,
      }),
    };
  }

  // Any live ask about this item, whichever session made it: the decision is
  // about the item, not about the run that happened to raise it. Approving one
  // answers the rest, which `supersedeActivationApprovals` then retires.
  const waiting = await db.approval.findFirst({
    where: {
      orgId: input.orgId,
      scopeId: item.scopeId,
      toolKey: ACTIVATE_ITEM_TOOL_KEY,
      argsHash: hashApprovalArgs({ itemId: item.id }),
      status: "pending",
      expiresAt: { gt: now },
    },
    orderBy: { createdAt: "desc" },
  });
  if (waiting) {
    const resolved = await approveApproval(db, {
      orgId: input.orgId,
      approvalId: waiting.id,
      approverPrincipalId: input.approverPrincipalId,
      now,
    });
    return { item: await getItem(db, input.orgId, item.id), approval: resolved.approval };
  }

  await assertMayConfirmActivation(db, {
    orgId: input.orgId,
    item,
    approverPrincipalId: input.approverPrincipalId,
  });
  const activated = await activateItem(db, {
    orgId: input.orgId,
    actorPrincipalId: input.approverPrincipalId,
    itemId: item.id,
  });
  // Nothing live was waiting, but an ask past its deadline that no sweep has
  // reached yet is still moot now.
  await supersedeActivationApprovals(db, {
    orgId: input.orgId,
    scopeId: item.scopeId,
    itemId: item.id,
  });
  return { item: activated };
}

export interface ClaimApprovalInput {
  orgId: string;
  approvalId: string;
  /**
   * The call about to run. It must be exactly the call that was approved, and
   * it is required: an executor that cannot say what it is about to run cannot
   * be told that the decision covers it.
   */
  args: unknown;
  now?: Date;
}

/**
 * Claim the single execution an approval permits.
 *
 * Two checks, both non-negotiable. Exact-args binding: the call about to run is
 * compared against the recorded arguments, and a changed call is refused rather
 * than quietly covered by a decision that was made about something else. There
 * is no way past this comparison — the arguments are a required input, so a
 * caller that omits them fails the comparison rather than skipping it.
 * At-most-once: the claim is a compare-and-swap on `executedAt`, so of any
 * number of concurrent executors exactly one proceeds and the rest are told the
 * call already ran.
 *
 * `expiresAt` is deliberately not one of them. It bounds how long a call waits
 * on a person, and it is enforced where that wait ends, in `assertResolvable`.
 * Once someone has said yes, the decision stands until it is executed: a
 * separate window between approval and execution is a different promise — one
 * nothing in the specs asks for yet — and adding it here would silently strand
 * a resumed run that came back a day later with a granted approval in hand.
 */
export async function claimApprovalExecution(
  db: Database,
  input: ClaimApprovalInput,
): Promise<Approval> {
  const now = input.now ?? new Date();
  const approval = await requireApproval(db, input.orgId, input.approvalId);
  if (approval.status !== "approved") {
    throw new ApprovalStateError("not_approved", `Approval is ${approval.status}, not approved`);
  }
  if (hashApprovalArgs(input.args) !== approval.argsHash) {
    log.warn("Approval arguments changed", {
      approvalId: approval.id,
      toolKey: approval.toolKey,
    });
    throw new ApprovalArgsMismatchError();
  }

  const claimed = await db.approval.updateMany({
    where: { id: approval.id, orgId: input.orgId, status: "approved", executedAt: null },
    data: { executedAt: now },
  });
  if (claimed.count !== 1) {
    log.warn("Approval already executed", { approvalId: approval.id, toolKey: approval.toolKey });
    throw new ApprovalStateError("already_executed", "This approval has already been executed");
  }

  log.info("Approval execution claimed", {
    approvalId: approval.id,
    sessionId: approval.sessionId,
    toolKey: approval.toolKey,
  });
  return db.approval.findUniqueOrThrow({
    where: { orgId_id: { orgId: input.orgId, id: approval.id } },
  });
}

/**
 * Give back a claim whose execution provably did not happen. It exists for the
 * in-process case where the work is one transaction and the rollback is
 * observable; a call that left the process keeps its claim, because "it might
 * have run" is exactly what at-most-once refuses to retry.
 */
export async function releaseApprovalExecution(
  db: Database,
  input: { orgId: string; approvalId: string },
): Promise<void> {
  const released = await db.approval.updateMany({
    where: { id: input.approvalId, orgId: input.orgId, status: "approved" },
    data: { executedAt: null },
  });
  if (released.count === 1) {
    log.warn("Approval execution released", { approvalId: input.approvalId });
  }
}

export interface ListApprovalsInput {
  orgId: string;
  /** Whose queue this is. Only approvals this principal may resolve are returned. */
  principal: AuthorizePrincipal;
  status?: ApprovalStatus;
  scopeId?: string;
  limit?: number;
  now?: Date;
}

/**
 * The approvals one person may resolve. The pinned rule on each row decides,
 * so the queue is the same set the approve call would accept.
 *
 * The rule is half a database question and half a role lookup, so the listing
 * reads pages and filters them until the caller's limit is filled rather than
 * filtering one page and returning what survives — an approver whose approvals
 * sit behind other people's must still see them. `APPROVAL_SCAN_LIMIT` bounds
 * the reading, so an empty queue costs a bounded scan and not the table.
 */
export async function listResolvableApprovals(
  db: Database,
  input: ListApprovalsInput,
): Promise<Approval[]> {
  const limit = input.limit ?? APPROVAL_PAGE_SIZE;
  const status = input.status ?? "pending";
  const where = {
    orgId: input.orgId,
    status,
    // An overdue ask is still `pending` until a sweep or a resolve attempt
    // records the expiry, but approve and deny would refuse it — and the queue
    // promises exactly the set the approve call would accept, so it never
    // shows one.
    ...(status === "pending" ? { expiresAt: { gt: input.now ?? new Date() } } : {}),
    ...(input.scopeId ? { scopeId: input.scopeId } : {}),
    // The one clause of resolvability the database can answer on its own: a
    // call the person who asked for it may not wave through is never theirs,
    // whatever roles they hold. The role half needs the scope chain, so it
    // stays in the filter below.
    OR: [
      { allowRequesterApproval: true },
      { requesterPrincipalId: null },
      { requesterPrincipalId: { not: input.principal.id } },
    ],
  };

  const rolesByScope = new Map<string, Role[]>();
  const resolvable: Approval[] = [];
  let scanned = 0;
  let cursor: string | undefined;

  while (resolvable.length < limit && scanned < APPROVAL_SCAN_LIMIT) {
    const take = Math.min(Math.max(limit, APPROVAL_PAGE_SIZE), APPROVAL_SCAN_LIMIT - scanned);
    const page = await db.approval.findMany({
      where,
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      take,
      ...(cursor ? { cursor: { orgId_id: { orgId: input.orgId, id: cursor } }, skip: 1 } : {}),
    });
    if (page.length === 0) break;
    scanned += page.length;
    cursor = page[page.length - 1]?.id;

    for (const approval of page) {
      let roles = rolesByScope.get(approval.scopeId);
      if (!roles) {
        roles = await approverRolesAtScope(db, input.principal, approval.scopeId);
        rolesByScope.set(approval.scopeId, roles);
      }
      const check = canResolveApproval({
        approval,
        approverPrincipalId: input.principal.id,
        approverRoles: roles,
      });
      if (check.ok) resolvable.push(approval);
      if (resolvable.length === limit) return resolvable;
    }
    if (page.length < take) break;
  }

  if (resolvable.length < limit && scanned >= APPROVAL_SCAN_LIMIT) {
    log.debug("Approval listing stopped at the scan limit", { scanned, found: resolvable.length });
  }
  return resolvable;
}

async function expireApproval(db: Database, approval: Approval): Promise<boolean> {
  const expired = await db.approval.updateMany({
    where: { id: approval.id, orgId: approval.orgId, status: "pending" },
    data: { status: "expired" },
  });
  if (expired.count !== 1) return false;
  await db.auditLog.create({
    data: {
      orgId: approval.orgId,
      // Nobody expired it; that is the point of recording it.
      actorPrincipalId: null,
      action: "approval.expired",
      subject: approval.id,
      payload: {
        sessionId: approval.sessionId,
        scopeId: approval.scopeId,
        toolKey: approval.toolKey,
        mode: approval.mode,
        expiresAt: approval.expiresAt.toISOString(),
        nudgeCount: approval.nudgeCount,
      },
    },
  });
  return true;
}

export interface SweepApprovalsInput {
  /** Sweep one organization. Absent sweeps every organization in the database. */
  orgId?: string;
  now?: Date;
  nudgeIntervalMs?: number;
  limit?: number;
}

export interface ApprovalSweepResult {
  /** Approvals moved to `expired` this pass. */
  expired: number;
  /** Approvals re-surfaced to their approvers this pass. */
  nudged: number;
}

/**
 * The re-nudge and expiry pass: a pending approval is re-surfaced every
 * interval and, at its deadline, expires visibly. Nothing here is silent —
 * that is the whole job.
 *
 * Idempotent by construction. Expiry is a compare-and-swap from `pending`, so a
 * duplicate firing expires nothing twice. A nudge is claimed the same way,
 * against a `nudgedAt` older than the interval, so two firings inside one
 * interval produce one nudge.
 *
 * Nothing schedules this yet: background work belongs on the engine that drives
 * runs (`../specs/operations/03-jobs.md`), and that wiring does not exist in
 * the repo — `services/schedules`'s `tickSchedules` waits on the same seam.
 */
export async function sweepApprovals(
  db: Database,
  input: SweepApprovalsInput = {},
): Promise<ApprovalSweepResult> {
  const startedAt = performance.now();
  const now = input.now ?? new Date();
  const limit = input.limit ?? APPROVAL_PAGE_SIZE;
  const nudgeThreshold = new Date(
    now.getTime() - (input.nudgeIntervalMs ?? APPROVAL_NUDGE_INTERVAL_MS),
  );
  const org = input.orgId ? { orgId: input.orgId } : {};

  const overdue = await db.approval.findMany({
    where: { ...org, status: "pending", expiresAt: { lte: now } },
    orderBy: { expiresAt: "asc" },
    take: limit,
  });
  let expired = 0;
  for (const approval of overdue) {
    if (await expireApproval(db, approval)) expired += 1;
  }

  // A nudge is due when nothing has re-surfaced the approval within the
  // interval; an approval that has never been nudged counts from its creation.
  const dueForNudge = {
    OR: [
      { nudgedAt: null, createdAt: { lte: nudgeThreshold } },
      { nudgedAt: { lte: nudgeThreshold } },
    ],
  };
  const waiting = await db.approval.findMany({
    where: { ...org, status: "pending", expiresAt: { gt: now }, ...dueForNudge },
    orderBy: { createdAt: "asc" },
    take: limit,
  });
  let nudged = 0;
  for (const approval of waiting) {
    const claimed = await db.approval.updateMany({
      where: { id: approval.id, orgId: approval.orgId, status: "pending", ...dueForNudge },
      data: { nudgedAt: now, nudgeCount: { increment: 1 } },
    });
    if (claimed.count === 1) nudged += 1;
  }

  log.info("Approval sweep completed", {
    expired,
    nudged,
    candidates: overdue.length + waiting.length,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return { expired, nudged };
}
