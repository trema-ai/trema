import type { ApprovalMode, Policy, Role, ScopeKind } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";

export type { ApprovalMode };

export const approvalModes = [
  "ask",
  "delegated",
  "full",
] as const satisfies readonly ApprovalMode[];

// Bump when the snapshot shape changes so old rows stay readable.
export const POLICY_SNAPSHOT_VERSION = 2;

/**
 * Permissiveness order. A policy's `maxMode` is a ceiling: the loosest mode a
 * human may choose where it applies, and the most restrictive applicable
 * ceiling wins.
 */
const MODE_RANK: Record<ApprovalMode, number> = { ask: 0, delegated: 1, full: 2 };

export function strictestMode(left: ApprovalMode, right: ApprovalMode): ApprovalMode {
  return MODE_RANK[left] <= MODE_RANK[right] ? left : right;
}

/** The stored fields resolution reads. Narrower than the Prisma row on purpose. */
export type PolicyRow = Pick<
  Policy,
  "id" | "scopeId" | "connectorKey" | "maxMode" | "approverRoles" | "allowRequesterApproval"
>;

/**
 * The policy rows a session pins for its whole life. Resolution happens per
 * call — the ceiling depends on which connector the call reaches — so the
 * snapshot carries the applicable rows, not a precomputed decision.
 */
export interface PolicySnapshot {
  version: number;
  scopeId: string;
  scopeChain: string[];
  rows: PolicyRow[];
}

/** Who may resolve an interrupt, and whether the asker may resolve their own. */
export interface ApprovalRouting {
  approverRoles: Role[];
  allowRequesterApproval: boolean;
  source: { kind: "default"; scopeKind: ScopeKind } | { kind: "policy"; policyId: string };
}

export class PolicyValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyValidationError";
  }
}

export class PolicyNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PolicyNotFoundError";
  }
}

/**
 * The ceiling nothing wrote a row for. `delegated` — never `full`: full access
 * exists only where a policy explicitly grants it, and `delegated` itself is
 * selectable only when a classifier model is configured, so the out-of-the-box
 * posture is that every call asks.
 */
export const DEFAULT_MODE_CEILING: ApprovalMode = "delegated";

/**
 * Routing when no policy row supplies one. The requester may resolve their own
 * interrupt everywhere — an ask-mode approval is the person confirming their
 * own agent's call, and separation of duties is a policy an org writes, not a
 * default that taxes every thread. Admins and owners can always step in; in a
 * personal scope the owner is the only approver there is.
 */
export function defaultRouting(scopeKind: ScopeKind): ApprovalRouting {
  return {
    approverRoles: scopeKind === "personal" ? ["owner"] : ["admin", "owner"],
    allowRequesterApproval: true,
    source: { kind: "default", scopeKind },
  };
}

export interface ResolveModeCeilingInput {
  /** The pinned rows ({@link PolicySnapshot.rows}) or a live read of the chain's rows. */
  rows: readonly PolicyRow[];
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
  /** The connector the call reaches; absent for calls that are not a connector's. */
  connectorKey?: string;
  /**
   * Whether the connector's catalog entry is trusted. An untrusted entry —
   * a custom MCP server, an unvetted import — pins to `ask` regardless of
   * policy; vetting the entry is the gate to anything looser.
   */
  connectorTrusted?: boolean;
}

/**
 * The loosest mode a human may choose for one call: the most restrictive
 * `maxMode` across every applicable row — scope-wide rows for scopes in the
 * chain, plus the connector's own rows — and {@link DEFAULT_MODE_CEILING} when
 * nothing wrote one. A narrower scope therefore tightens a wider scope's
 * ceiling and never loosens it.
 */
export function resolveModeCeiling(input: ResolveModeCeilingInput): ApprovalMode {
  if (input.connectorKey !== undefined && input.connectorTrusted !== true) return "ask";
  const chain = new Set(input.scopeChain);
  const applicable = input.rows.filter(
    (row) =>
      chain.has(row.scopeId) &&
      (row.connectorKey === null ||
        (input.connectorKey !== undefined && row.connectorKey === input.connectorKey)),
  );
  return applicable.reduce<ApprovalMode>(
    (ceiling, row) => strictestMode(ceiling, row.maxMode),
    applicable.length === 0 ? DEFAULT_MODE_CEILING : "full",
  );
}

export interface ResolveApprovalRoutingInput {
  rows: readonly PolicyRow[];
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
  scopeKind: ScopeKind;
  connectorKey?: string;
}

/**
 * Who resolves an interrupt: the most specific applicable row — the
 * connector's own row before a scope-wide one, a narrower scope before a wider
 * one — and the built-in defaults when nothing wrote a row.
 */
export function resolveApprovalRouting(input: ResolveApprovalRoutingInput): ApprovalRouting {
  for (const connectorSpecific of [true, false]) {
    for (let index = input.scopeChain.length - 1; index >= 0; index -= 1) {
      const row = input.rows.find(
        (candidate) =>
          candidate.scopeId === input.scopeChain[index] &&
          (connectorSpecific
            ? input.connectorKey !== undefined && candidate.connectorKey === input.connectorKey
            : candidate.connectorKey === null),
      );
      if (!row) continue;
      return {
        approverRoles: [...row.approverRoles],
        allowRequesterApproval: row.allowRequesterApproval,
        source: { kind: "policy", policyId: row.id },
      };
    }
  }
  return defaultRouting(input.scopeKind);
}

export interface ResolveEffectiveModeInput extends ResolveModeCeilingInput {
  /** The mode the requester chose for the thread. */
  requestedMode: ApprovalMode;
  /**
   * Whether a classifier model is configured. Without one `delegated` is
   * unavailable — the safe default needs no LLM — so a delegated choice or
   * ceiling degrades to `ask`.
   */
  classifierAvailable: boolean;
}

/**
 * The mode one call actually runs under: the requester's choice clamped to
 * the ceiling, with `delegated` degrading to `ask` when no classifier exists.
 */
export function resolveEffectiveMode(input: ResolveEffectiveModeInput): ApprovalMode {
  const clamped = strictestMode(input.requestedMode, resolveModeCeiling(input));
  return clamped === "delegated" && !input.classifierAvailable ? "ask" : clamped;
}

const policyRowSelect = {
  id: true,
  scopeId: true,
  connectorKey: true,
  maxMode: true,
  approverRoles: true,
  allowRequesterApproval: true,
} as const;

export interface ResolvePolicySnapshotInput {
  orgId: string;
  scopeId: string;
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
}

/**
 * Pin the policy rows that govern a session for its whole life.
 *
 * The caller stores the returned snapshot on the session row, so a policy
 * edited mid-run reaches the next session and never the running one.
 */
export async function resolvePolicySnapshot(
  db: Database,
  input: ResolvePolicySnapshotInput,
): Promise<PolicySnapshot> {
  const rows = await db.policy.findMany({
    where: { orgId: input.orgId, scopeId: { in: [...input.scopeChain] } },
    select: policyRowSelect,
    orderBy: [{ scopeId: "asc" }, { connectorKey: "asc" }],
  });
  log.debug("Policy snapshot resolved", {
    scopeId: input.scopeId,
    version: POLICY_SNAPSHOT_VERSION,
    storedPolicies: rows.length,
  });
  return {
    version: POLICY_SNAPSHOT_VERSION,
    scopeId: input.scopeId,
    scopeChain: [...input.scopeChain],
    rows,
  };
}

export interface ListPoliciesInput {
  orgId: string;
  scopeId?: string;
}

export async function listPolicies(db: Database, input: ListPoliciesInput): Promise<Policy[]> {
  return db.policy.findMany({
    where: { orgId: input.orgId, ...(input.scopeId ? { scopeId: input.scopeId } : {}) },
    orderBy: [{ scopeId: "asc" }, { connectorKey: { sort: "asc", nulls: "first" } }],
  });
}

export interface SetPolicyInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  /** The connector the row governs; absent bounds every connector in the scope. */
  connectorKey?: string;
  maxMode: ApprovalMode;
  approverRoles?: Role[];
  allowRequesterApproval?: boolean;
}

/**
 * Validate one written policy. The one rule is that a row's interrupts must be
 * resolvable by someone: a row naming no approver role and refusing requester
 * approval promises a pause nobody can end.
 */
function normalizeWrite(input: SetPolicyInput): {
  maxMode: ApprovalMode;
  approverRoles: Role[];
  allowRequesterApproval: boolean;
} {
  const approverRoles = [...new Set(input.approverRoles ?? [])];
  const allowRequesterApproval = input.allowRequesterApproval ?? true;
  if (approverRoles.length === 0 && !allowRequesterApproval) {
    throw new PolicyValidationError(
      "A policy needs an approver role or requester approval; nobody could resolve its interrupts",
    );
  }
  return { maxMode: input.maxMode, approverRoles, allowRequesterApproval };
}

/**
 * Create or replace the policy for one scope and connector (or the scope-wide
 * row). A scope holds at most one row per key, so writing is a set, not an
 * append; the partial unique indexes hold that under concurrency.
 */
export async function setPolicy(db: Database, input: SetPolicyInput): Promise<Policy> {
  const scope = await db.scope.findFirst({
    where: { id: input.scopeId, orgId: input.orgId },
    select: { id: true, kind: true },
  });
  if (!scope) {
    log.warn("Policy target scope not found", { scopeId: input.scopeId });
    throw new PolicyNotFoundError("Policy target scope not found");
  }
  const connectorKey = input.connectorKey?.trim() || null;
  const written = normalizeWrite(input);

  const policy = await db.$transaction(async (transaction) => {
    const existing = await transaction.policy.findFirst({
      where: { orgId: input.orgId, scopeId: input.scopeId, connectorKey },
    });
    const policy = existing
      ? await transaction.policy.update({
          where: { orgId_id: { orgId: input.orgId, id: existing.id } },
          data: written,
        })
      : await transaction.policy.create({
          data: { orgId: input.orgId, scopeId: input.scopeId, connectorKey, ...written },
        });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.set",
        subject: policy.id,
        payload: {
          scopeId: policy.scopeId,
          connectorKey: policy.connectorKey,
          maxMode: policy.maxMode,
          approverRoles: policy.approverRoles,
          allowRequesterApproval: policy.allowRequesterApproval,
        },
      },
    });
    return policy;
  });

  log.info("Approval policy set", {
    policyId: policy.id,
    scopeId: policy.scopeId,
    connectorKey: policy.connectorKey,
    maxMode: policy.maxMode,
  });
  return policy;
}

export interface DeletePolicyInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  connectorKey?: string;
}

/**
 * Remove one scope's row for a connector (or its scope-wide row). The ceiling
 * then resolves through the remaining rows, or the built-in default.
 */
export async function deletePolicy(db: Database, input: DeletePolicyInput): Promise<Policy> {
  const connectorKey = input.connectorKey?.trim() || null;
  const policy = await db.$transaction(async (transaction) => {
    const existing = await transaction.policy.findFirst({
      where: { orgId: input.orgId, scopeId: input.scopeId, connectorKey },
    });
    if (!existing) {
      throw new PolicyNotFoundError("Policy not found");
    }
    await transaction.policy.delete({
      where: { orgId_id: { orgId: input.orgId, id: existing.id } },
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.delete",
        subject: existing.id,
        payload: {
          scopeId: existing.scopeId,
          connectorKey: existing.connectorKey,
          maxMode: existing.maxMode,
        },
      },
    });
    return existing;
  });

  log.info("Approval policy removed", {
    policyId: policy.id,
    scopeId: policy.scopeId,
    connectorKey: policy.connectorKey,
  });
  return policy;
}

async function resolveScopeChainIds(
  db: Database,
  orgId: string,
  scope: { id: string; kind: ScopeKind },
): Promise<string[]> {
  if (scope.kind === "org") return [scope.id];
  const orgScope = await db.scope.findFirst({
    where: { orgId, kind: "org" },
    select: { id: true },
  });
  if (!orgScope) throw new PolicyNotFoundError("Organization scope not found");
  return [orgScope.id, scope.id];
}

export interface ResolveScopePoliciesInput {
  orgId: string;
  scopeId: string;
  /** Resolve the ceiling one connector would get; absent resolves the scope-wide view. */
  connectorKey?: string;
  /** The connector's catalog trust; only read when `connectorKey` is present. */
  connectorTrusted?: boolean;
}

export interface ResolvedScopePolicies {
  scopeId: string;
  scopeChain: string[];
  rows: PolicyRow[];
  /** The loosest mode a human may choose here, before classifier availability. */
  ceiling: ApprovalMode;
  routing: ApprovalRouting;
}

/**
 * What a session opened against this scope would resolve right now. The
 * control-plane read of the same logic sessions pin, so an admin can see the
 * effective ceiling without opening one.
 */
export async function resolveScopePolicies(
  db: Database,
  input: ResolveScopePoliciesInput,
): Promise<ResolvedScopePolicies> {
  const scope = await db.scope.findFirst({
    where: { id: input.scopeId, orgId: input.orgId },
    select: { id: true, kind: true },
  });
  if (!scope) {
    log.warn("Policy resolution scope not found", { scopeId: input.scopeId });
    throw new PolicyNotFoundError("Scope not found");
  }

  const scopeChain = await resolveScopeChainIds(db, input.orgId, scope);
  const snapshot = await resolvePolicySnapshot(db, {
    orgId: input.orgId,
    scopeId: scope.id,
    scopeChain,
  });
  const connector =
    input.connectorKey === undefined
      ? {}
      : { connectorKey: input.connectorKey, connectorTrusted: input.connectorTrusted ?? false };
  return {
    scopeId: scope.id,
    scopeChain,
    rows: snapshot.rows,
    ceiling: resolveModeCeiling({ rows: snapshot.rows, scopeChain, ...connector }),
    routing: resolveApprovalRouting({
      rows: snapshot.rows,
      scopeChain,
      scopeKind: scope.kind,
      ...(input.connectorKey === undefined ? {} : { connectorKey: input.connectorKey }),
    }),
  };
}
