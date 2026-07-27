import type {
  Policy,
  PolicyAction,
  Role,
  ScopeKind,
  Sensitivity,
} from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";

export type { PolicyAction, Sensitivity };

export const sensitivityClasses = [
  "read",
  "write",
  "destructive",
] as const satisfies readonly Sensitivity[];

export const policyActions = [
  "allow",
  "require_approval",
  "deny",
] as const satisfies readonly PolicyAction[];

// Bump when the snapshot shape changes so old rows stay readable.
export const POLICY_SNAPSHOT_VERSION = 1;

/** Where a resolved decision came from: a stored policy, or the built-in default. */
export type PolicyDecisionSource =
  | { kind: "default"; scopeKind: ScopeKind }
  | { kind: "policy"; policyId: string; scopeId: string };

export interface PolicyDecision {
  sensitivity: Sensitivity;
  action: PolicyAction;
  approverRoles: Role[];
  allowRequesterApproval: boolean;
  source: PolicyDecisionSource;
}

export interface PolicySnapshot {
  version: number;
  scopeId: string;
  scopeChain: string[];
  decisions: Record<Sensitivity, PolicyDecision>;
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

const approverRoles: Role[] = ["owner", "admin"];

// The defaults from the permissions spec. Shared and organization scopes gate
// writes and destructive calls; a personal scope treats the ask itself as the
// approval for writes and keeps a confirm step for destructive calls. The
// requester may never be the sole approver of a destructive call in a scope
// other people share.
function defaultDecision(sensitivity: Sensitivity, scopeKind: ScopeKind): PolicyDecision {
  const source: PolicyDecisionSource = { kind: "default", scopeKind };
  const personal = scopeKind === "personal";

  if (sensitivity === "read") {
    return {
      sensitivity,
      action: "allow",
      approverRoles: [],
      allowRequesterApproval: true,
      source,
    };
  }
  if (sensitivity === "write") {
    return {
      sensitivity,
      action: personal ? "allow" : "require_approval",
      approverRoles: personal ? [] : approverRoles,
      allowRequesterApproval: true,
      source,
    };
  }
  return {
    sensitivity,
    action: "require_approval",
    approverRoles: personal ? ["owner"] : approverRoles,
    allowRequesterApproval: personal,
    source,
  };
}

export function defaultDecisions(scopeKind: ScopeKind): Record<Sensitivity, PolicyDecision> {
  return {
    read: defaultDecision("read", scopeKind),
    write: defaultDecision("write", scopeKind),
    destructive: defaultDecision("destructive", scopeKind),
  };
}

/** The stored fields resolution reads. Narrower than the Prisma row on purpose. */
export type PolicyRow = Pick<
  Policy,
  "id" | "scopeId" | "sensitivity" | "action" | "approverRoles" | "allowRequesterApproval"
>;

function decisionFromRow(row: PolicyRow): PolicyDecision {
  return {
    sensitivity: row.sensitivity,
    action: row.action,
    approverRoles: [...row.approverRoles],
    allowRequesterApproval: row.allowRequesterApproval,
    source: { kind: "policy", policyId: row.id, scopeId: row.scopeId },
  };
}

/**
 * Most-specific-wins, one class at a time: the narrowest scope in the chain
 * holding a row for that sensitivity decides it, and a class nobody wrote a row
 * for falls back to the built-in default. Classes resolve independently, so a
 * shared scope can gate deletions without restating the org's read rule.
 */
export function resolveDecisions(input: {
  scopeKind: ScopeKind;
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
  policies: readonly PolicyRow[];
}): Record<Sensitivity, PolicyDecision> {
  const decisions = defaultDecisions(input.scopeKind);

  for (const sensitivity of sensitivityClasses) {
    for (let index = input.scopeChain.length - 1; index >= 0; index -= 1) {
      const row = input.policies.find(
        (policy) =>
          policy.scopeId === input.scopeChain[index] && policy.sensitivity === sensitivity,
      );
      if (!row) continue;
      decisions[sensitivity] = decisionFromRow(row);
      break;
    }
  }

  return decisions;
}

export interface ResolvePolicySnapshotInput {
  orgId: string;
  scopeId: string;
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
  scopeKind: ScopeKind;
}

/**
 * Resolve the approval policy that governs a session for its whole life.
 *
 * The caller pins the returned snapshot on the session row, so a policy edited
 * mid-run reaches the next session and never the running one.
 */
export async function resolvePolicySnapshot(
  db: Database,
  input: ResolvePolicySnapshotInput,
): Promise<PolicySnapshot> {
  const policies = await db.policy.findMany({
    where: { orgId: input.orgId, scopeId: { in: [...input.scopeChain] } },
    select: {
      id: true,
      scopeId: true,
      sensitivity: true,
      action: true,
      approverRoles: true,
      allowRequesterApproval: true,
    },
  });
  const decisions = resolveDecisions({
    scopeKind: input.scopeKind,
    scopeChain: input.scopeChain,
    policies,
  });
  log.debug("Policy snapshot resolved", {
    scopeId: input.scopeId,
    scopeKind: input.scopeKind,
    version: POLICY_SNAPSHOT_VERSION,
    storedPolicies: policies.length,
    write: decisions.write.action,
    destructive: decisions.destructive.action,
  });
  return {
    version: POLICY_SNAPSHOT_VERSION,
    scopeId: input.scopeId,
    scopeChain: [...input.scopeChain],
    decisions,
  };
}

export interface ListPoliciesInput {
  orgId: string;
  scopeId?: string;
}

export async function listPolicies(db: Database, input: ListPoliciesInput): Promise<Policy[]> {
  return db.policy.findMany({
    where: { orgId: input.orgId, ...(input.scopeId ? { scopeId: input.scopeId } : {}) },
    orderBy: [{ scopeId: "asc" }, { sensitivity: "asc" }],
  });
}

export interface PolicyWrite {
  action: PolicyAction;
  approverRoles?: Role[];
  allowRequesterApproval?: boolean;
}

interface NormalizedWrite {
  action: PolicyAction;
  approverRoles: Role[];
  allowRequesterApproval: boolean;
}

/**
 * Validate one written policy against the scope it lands in.
 *
 * Both rules are about who can actually resolve the approval a row promises. A
 * row nobody may resolve is a `deny` written the confusing way. And in a scope
 * other people share, an approver role is required: the separation of duties
 * the permissions spec builds the destructive default around only holds if
 * someone other than the requester can say yes. A personal scope is the
 * exception, because there the requester alone is the point — the approval is
 * the owner's own confirm step.
 *
 * An `allow` or `deny` row has no approval to resolve, so its approver fields
 * are stored empty rather than kept as dead configuration a reader would have
 * to interpret.
 */
function normalizeWrite(write: PolicyWrite, scopeKind: ScopeKind): NormalizedWrite {
  if (write.action !== "require_approval") {
    return { action: write.action, approverRoles: [], allowRequesterApproval: false };
  }

  const approverRoles = [...new Set(write.approverRoles ?? [])];
  const allowRequesterApproval = write.allowRequesterApproval ?? false;

  if (approverRoles.length === 0 && !allowRequesterApproval) {
    throw new PolicyValidationError(
      "A require_approval policy needs an approver role or requester approval; use deny to disable the class",
    );
  }
  if (approverRoles.length === 0 && scopeKind !== "personal") {
    throw new PolicyValidationError(
      "A require_approval policy outside a personal scope needs an approver role: the requester cannot be its sole approver",
    );
  }

  return { action: write.action, approverRoles, allowRequesterApproval };
}

export interface SetPolicyInput extends PolicyWrite {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  sensitivity: Sensitivity;
}

/**
 * Create or replace the policy for one scope and sensitivity class. A scope
 * holds at most one row per class, so writing is a set, not an append.
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

  const written = normalizeWrite(input, scope.kind);

  const policy = await db.$transaction(async (transaction) => {
    const policy = await transaction.policy.upsert({
      where: {
        orgId_scopeId_sensitivity: {
          orgId: input.orgId,
          scopeId: input.scopeId,
          sensitivity: input.sensitivity,
        },
      },
      create: {
        orgId: input.orgId,
        scopeId: input.scopeId,
        sensitivity: input.sensitivity,
        ...written,
      },
      update: written,
    });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.set",
        subject: policy.id,
        payload: {
          scopeId: policy.scopeId,
          sensitivity: policy.sensitivity,
          action: policy.action,
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
    sensitivity: policy.sensitivity,
    action: policy.action,
  });
  return policy;
}

export interface DeletePolicyInput {
  orgId: string;
  actorPrincipalId: string;
  scopeId: string;
  sensitivity: Sensitivity;
}

/**
 * Remove one scope's policy for a class. The class then resolves through the
 * wider scope, or through the built-in default when nothing else carries a row.
 */
export async function deletePolicy(db: Database, input: DeletePolicyInput): Promise<Policy> {
  const policy = await db.$transaction(async (transaction) => {
    const existing = await transaction.policy.findFirst({
      where: { orgId: input.orgId, scopeId: input.scopeId, sensitivity: input.sensitivity },
    });
    if (!existing) {
      throw new PolicyNotFoundError("Policy not found");
    }
    await transaction.policy.delete({ where: { id: existing.id } });
    await transaction.auditLog.create({
      data: {
        orgId: input.orgId,
        actorPrincipalId: input.actorPrincipalId,
        action: "policy.delete",
        subject: existing.id,
        payload: {
          scopeId: existing.scopeId,
          sensitivity: existing.sensitivity,
          action: existing.action,
        },
      },
    });
    return existing;
  });

  log.info("Approval policy removed", {
    policyId: policy.id,
    scopeId: policy.scopeId,
    sensitivity: policy.sensitivity,
  });
  return policy;
}

export interface ResolveScopePoliciesInput {
  orgId: string;
  scopeId: string;
}

export interface ResolvedScopePolicies {
  scopeId: string;
  scopeChain: string[];
  decisions: Record<Sensitivity, PolicyDecision>;
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

/**
 * What a session opened against this scope would resolve right now. The
 * control-plane read of the same logic sessions pin, so an admin can see the
 * effective policy without opening one.
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
    scopeKind: scope.kind,
  });
  return { scopeId: scope.id, scopeChain, decisions: snapshot.decisions };
}
