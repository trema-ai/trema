import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import {
  DEFAULT_MODE_CEILING,
  defaultRouting,
  PolicyValidationError,
  setPolicy,
} from "#server/services/policies/index.js";

describe("default approval policy", () => {
  it("caps the out-of-the-box ceiling at delegated, never full", () => {
    expect(DEFAULT_MODE_CEILING).toBe("delegated");
  });

  it("routes shared- and org-scope approvals to admins and owners", () => {
    for (const scopeKind of ["shared", "org"] as const) {
      expect(defaultRouting(scopeKind)).toEqual({
        approverRoles: ["admin", "owner"],
        allowRequesterApproval: true,
        source: { kind: "default", scopeKind },
      });
    }
  });

  it("routes personal-scope approvals to the owner alone", () => {
    expect(defaultRouting("personal")).toEqual({
      approverRoles: ["owner"],
      allowRequesterApproval: true,
      source: { kind: "default", scopeKind: "personal" },
    });
  });
});

describe("policy write validation", () => {
  // setPolicy validates after the scope lookup and before any write, so a db
  // stub that only answers the lookup exercises the rule without a database.
  const db = {
    scope: {
      findFirst: async () => ({ id: "scope-shared", kind: "shared" as const }),
    },
  } as unknown as Database;

  it("rejects a row whose interrupts nobody could resolve", async () => {
    await expect(
      setPolicy(db, {
        orgId: "org-1",
        actorPrincipalId: "principal-1",
        scopeId: "scope-shared",
        maxMode: "ask",
        approverRoles: [],
        allowRequesterApproval: false,
      }),
    ).rejects.toBeInstanceOf(PolicyValidationError);
  });
});
