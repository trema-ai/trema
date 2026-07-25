import type { Role, ScopeKind } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import type { Sensitivity } from "#/services/connectors/index.js";

export const sensitivityClasses = ["read", "write", "destructive"] as const;

export const policyActions = ["allow", "require_approval", "deny"] as const;
export type PolicyAction = (typeof policyActions)[number];

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
 * Resolution is most-specific-wins per sensitivity class over the scope chain,
 * falling back to the built-in defaults. Stored policy rows do not exist yet,
 * so every decision resolves to a default and records that in its `source`.
 * Reading rows here later changes no caller and no stored snapshot shape.
 */
export async function resolvePolicySnapshot(
  _db: Database,
  input: ResolvePolicySnapshotInput,
): Promise<PolicySnapshot> {
  const decisions = defaultDecisions(input.scopeKind);
  log.debug("Policy snapshot resolved", {
    scopeId: input.scopeId,
    scopeKind: input.scopeKind,
    version: POLICY_SNAPSHOT_VERSION,
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
