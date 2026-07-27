import { describe, expect, it } from "vitest";

import type { Approval, Role, Sensitivity } from "#server/generated/prisma/client.js";
import {
  ACTIVATE_ITEM_TOOL_KEY,
  canResolveApproval,
  hashApprovalArgs,
  resolveApprovalRequirement,
} from "#server/services/approvals/index.js";
import { defaultDecisions, type PolicyDecision } from "#server/services/policies/index.js";

function decisions(
  overrides: Partial<Record<Sensitivity, Partial<PolicyDecision>>> = {},
  scopeKind: "org" | "shared" | "personal" = "shared",
): Record<Sensitivity, PolicyDecision> {
  const base = defaultDecisions(scopeKind);
  return {
    read: { ...base.read, ...overrides.read },
    write: { ...base.write, ...overrides.write },
    destructive: { ...base.destructive, ...overrides.destructive },
  };
}

function approval(overrides: Partial<Approval> = {}) {
  return {
    approverRoles: ["admin"] as Role[],
    allowRequesterApproval: false,
    requesterPrincipalId: "requester",
    ...overrides,
  } as Pick<Approval, "approverRoles" | "allowRequesterApproval" | "requesterPrincipalId">;
}

describe("approval requirement resolution", () => {
  it("passes the pinned decision through for an ordinary tool call", () => {
    const requirement = resolveApprovalRequirement({
      decisions: decisions({
        destructive: { action: "require_approval", approverRoles: ["owner"] },
      }),
      scopeKind: "shared",
      toolKey: "github:delete_repo",
      sensitivity: "destructive",
    });

    expect(requirement).toMatchObject({
      action: "require_approval",
      approverRoles: ["owner"],
      allowRequesterApproval: false,
    });
  });

  it("reads an allowed class as no approval at all", () => {
    const requirement = resolveApprovalRequirement({
      decisions: decisions({ write: { action: "allow" } }),
      scopeKind: "shared",
      toolKey: "github:open_issue",
      sensitivity: "write",
    });

    expect(requirement.action).toBe("allow");
  });

  it("gates item activation even where the policy allows writes outright", () => {
    const requirement = resolveApprovalRequirement({
      decisions: decisions({ write: { action: "allow", approverRoles: [] } }),
      scopeKind: "shared",
      toolKey: ACTIVATE_ITEM_TOOL_KEY,
      sensitivity: "write",
    });

    // The policy said nothing about who confirms, so the scope kind's default
    // approvers stand in.
    expect(requirement).toMatchObject({
      action: "require_approval",
      approverRoles: ["owner", "admin"],
    });
  });

  it("keeps a personal scope's activation with its owner", () => {
    const requirement = resolveApprovalRequirement({
      decisions: decisions({}, "personal"),
      scopeKind: "personal",
      toolKey: ACTIVATE_ITEM_TOOL_KEY,
      sensitivity: "write",
    });

    expect(requirement).toMatchObject({
      action: "require_approval",
      approverRoles: [],
      allowRequesterApproval: true,
    });
  });

  it("takes the policy's approvers for activation when the scope gates writes", () => {
    const requirement = resolveApprovalRequirement({
      decisions: decisions({
        write: {
          action: "require_approval",
          approverRoles: ["owner"],
          allowRequesterApproval: false,
        },
      }),
      scopeKind: "shared",
      toolKey: ACTIVATE_ITEM_TOOL_KEY,
      sensitivity: "write",
    });

    expect(requirement).toMatchObject({
      approverRoles: ["owner"],
      allowRequesterApproval: false,
    });
  });
});

describe("approver validation", () => {
  it("accepts a holder of one of the pinned roles", () => {
    expect(
      canResolveApproval({
        approval: approval(),
        approverPrincipalId: "someone-else",
        approverRoles: ["admin", "member"],
      }),
    ).toEqual({ ok: true });
  });

  it("refuses a principal holding none of them", () => {
    expect(
      canResolveApproval({
        approval: approval(),
        approverPrincipalId: "someone-else",
        approverRoles: ["member"],
      }),
    ).toEqual({ ok: false, reason: "role_required" });
  });

  it("refuses the requester even when they hold an approver role", () => {
    expect(
      canResolveApproval({
        approval: approval(),
        approverPrincipalId: "requester",
        approverRoles: ["owner", "admin"],
      }),
    ).toEqual({ ok: false, reason: "requester_self_approval" });
  });

  it("lets the requester through when the pinned rule allows it", () => {
    expect(
      canResolveApproval({
        approval: approval({ allowRequesterApproval: true, approverRoles: [] }),
        approverPrincipalId: "requester",
        approverRoles: [],
      }),
    ).toEqual({ ok: true });
  });

  it("does not let requester approval widen the rule for anyone else", () => {
    expect(
      canResolveApproval({
        approval: approval({ allowRequesterApproval: true }),
        approverPrincipalId: "bystander",
        approverRoles: ["member"],
      }),
    ).toEqual({ ok: false, reason: "role_required" });
  });
});

describe("exact-args binding", () => {
  it("ignores key order, because key order is not part of the call", () => {
    expect(hashApprovalArgs({ a: 1, b: { c: 2, d: 3 } })).toBe(
      hashApprovalArgs({ b: { d: 3, c: 2 }, a: 1 }),
    );
  });

  it("separates a changed value, an added field, and a reordered array", () => {
    const base = hashApprovalArgs({ channel: "#ops", text: "deploy" });
    expect(hashApprovalArgs({ channel: "#exec", text: "deploy" })).not.toBe(base);
    expect(hashApprovalArgs({ channel: "#ops", text: "deploy", silent: true })).not.toBe(base);
    expect(hashApprovalArgs({ ids: ["a", "b"] })).not.toBe(hashApprovalArgs({ ids: ["b", "a"] }));
  });

  it("hashes an absent argument list the same way every time", () => {
    expect(hashApprovalArgs(undefined)).toBe(hashApprovalArgs(null));
  });
});
