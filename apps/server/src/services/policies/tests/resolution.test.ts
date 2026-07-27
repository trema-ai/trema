import { describe, expect, it } from "vitest";

import { type PolicyRow, resolveDecisions } from "#server/services/policies/index.js";

const ORG = "scope-org";
const SHARED = "scope-shared";

function row(overrides: Partial<PolicyRow> & Pick<PolicyRow, "id" | "scopeId" | "sensitivity">) {
  return {
    action: "require_approval",
    approverRoles: ["admin"],
    allowRequesterApproval: false,
    ...overrides,
  } satisfies PolicyRow;
}

describe("approval policy resolution", () => {
  it("falls back to the defaults when no scope in the chain carries a row", () => {
    const decisions = resolveDecisions({
      scopeKind: "shared",
      scopeChain: [ORG, SHARED],
      policies: [],
    });

    expect(decisions.read).toMatchObject({ action: "allow", source: { kind: "default" } });
    expect(decisions.write).toMatchObject({ action: "require_approval" });
    expect(decisions.destructive).toMatchObject({ action: "require_approval" });
  });

  it("takes the organization row when only the organization carries one", () => {
    const decisions = resolveDecisions({
      scopeKind: "shared",
      scopeChain: [ORG, SHARED],
      policies: [row({ id: "p-org", scopeId: ORG, sensitivity: "write", action: "allow" })],
    });

    expect(decisions.write).toMatchObject({
      action: "allow",
      source: { kind: "policy", policyId: "p-org", scopeId: ORG },
    });
  });

  it("lets the narrowest scope in the chain win over a wider one", () => {
    const decisions = resolveDecisions({
      scopeKind: "shared",
      scopeChain: [ORG, SHARED],
      policies: [
        row({ id: "p-org", scopeId: ORG, sensitivity: "destructive", action: "allow" }),
        row({ id: "p-shared", scopeId: SHARED, sensitivity: "destructive", action: "deny" }),
      ],
    });

    expect(decisions.destructive).toMatchObject({
      action: "deny",
      source: { kind: "policy", policyId: "p-shared", scopeId: SHARED },
    });
  });

  it("resolves each sensitivity class independently", () => {
    const decisions = resolveDecisions({
      scopeKind: "shared",
      scopeChain: [ORG, SHARED],
      policies: [
        row({ id: "p-org-read", scopeId: ORG, sensitivity: "read", action: "deny" }),
        row({
          id: "p-shared-write",
          scopeId: SHARED,
          sensitivity: "write",
          action: "require_approval",
          approverRoles: ["owner"],
          allowRequesterApproval: true,
        }),
      ],
    });

    // The organization's read rule survives a shared-scope write rule, and the
    // class nobody wrote for keeps its default.
    expect(decisions.read).toMatchObject({ action: "deny", source: { policyId: "p-org-read" } });
    expect(decisions.write).toMatchObject({
      approverRoles: ["owner"],
      allowRequesterApproval: true,
      source: { policyId: "p-shared-write" },
    });
    expect(decisions.destructive.source).toEqual({ kind: "default", scopeKind: "shared" });
  });

  it("ignores rows from scopes outside the chain", () => {
    const decisions = resolveDecisions({
      scopeKind: "shared",
      scopeChain: [ORG, SHARED],
      policies: [row({ id: "p-other", scopeId: "scope-elsewhere", sensitivity: "write" })],
    });

    expect(decisions.write.source).toEqual({ kind: "default", scopeKind: "shared" });
  });

  it("resolves an organization session over the organization scope alone", () => {
    const decisions = resolveDecisions({
      scopeKind: "org",
      scopeChain: [ORG],
      policies: [
        row({ id: "p-org", scopeId: ORG, sensitivity: "write", action: "deny" }),
        row({ id: "p-shared", scopeId: SHARED, sensitivity: "write", action: "allow" }),
      ],
    });

    expect(decisions.write).toMatchObject({ action: "deny", source: { policyId: "p-org" } });
  });

  it("keeps a personal scope's defaults for the classes it has not tightened", () => {
    const decisions = resolveDecisions({
      scopeKind: "personal",
      scopeChain: [ORG, "scope-personal"],
      policies: [
        row({
          id: "p-personal",
          scopeId: "scope-personal",
          sensitivity: "destructive",
          action: "deny",
        }),
      ],
    });

    expect(decisions.write).toMatchObject({ action: "allow", source: { scopeKind: "personal" } });
    expect(decisions.destructive).toMatchObject({ action: "deny" });
  });
});
