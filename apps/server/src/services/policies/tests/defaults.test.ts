import { describe, expect, it } from "vitest";

import { defaultDecisions } from "#server/services/policies/index.js";

describe("default approval policy", () => {
  it("allows reads, gates writes, and gates destructive calls in shared scopes", () => {
    const decisions = defaultDecisions("shared");

    expect(decisions.read).toMatchObject({ action: "allow" });
    expect(decisions.write).toMatchObject({
      action: "require_approval",
      approverRoles: ["owner", "admin"],
      allowRequesterApproval: true,
    });
    // Separation of duties: whoever asked for the deletion is not its only
    // approver.
    expect(decisions.destructive).toMatchObject({
      action: "require_approval",
      approverRoles: ["owner", "admin"],
      allowRequesterApproval: false,
    });
  });

  it("treats a personal-scope write as approved by the asking and confirms deletions", () => {
    const decisions = defaultDecisions("personal");

    expect(decisions.write).toMatchObject({ action: "allow" });
    expect(decisions.destructive).toMatchObject({
      action: "require_approval",
      allowRequesterApproval: true,
    });
  });

  it("records that each decision came from a default", () => {
    for (const decision of Object.values(defaultDecisions("org"))) {
      expect(decision.source).toEqual({ kind: "default", scopeKind: "org" });
    }
  });
});
