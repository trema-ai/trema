import { describe, expect, it } from "vitest";

import type { Approval, Role, ScopeKind } from "#server/generated/prisma/client.js";
import {
  ApprovalValidationError,
  canResolveApproval,
  hashApprovalArgs,
  routingForSession,
} from "#server/services/approvals/index.js";
import type { PolicyRow } from "#server/services/policies/index.js";

const ORG = "scope-org";
const SHARED = "scope-shared";

type SessionInput = Parameters<typeof routingForSession>[0];

function pinnedSession(rows: PolicyRow[] | null, scopeKind: ScopeKind = "shared"): SessionInput {
  return {
    scopeChain: [ORG, SHARED],
    policySnapshot:
      rows === null ? null : { version: 2, scopeId: SHARED, scopeChain: [ORG, SHARED], rows },
    scope: { id: SHARED, kind: scopeKind },
  } as unknown as SessionInput;
}

function row(overrides: Partial<PolicyRow> & Pick<PolicyRow, "id" | "scopeId">): PolicyRow {
  return {
    connectorKey: null,
    maxMode: "ask",
    approverRoles: ["admin"],
    allowRequesterApproval: false,
    ...overrides,
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

describe("routing from the pinned snapshot", () => {
  it("routes through the most specific pinned row, never live policy", () => {
    const routing = routingForSession(
      pinnedSession([
        row({ id: "p-org", scopeId: ORG, approverRoles: ["owner"] }),
        row({ id: "p-shared", scopeId: SHARED, approverRoles: ["admin"] }),
      ]),
    );

    expect(routing).toMatchObject({
      approverRoles: ["admin"],
      allowRequesterApproval: false,
      source: { kind: "policy", policyId: "p-shared" },
    });
  });

  it("routes a connector call through the connector's own row", () => {
    const routing = routingForSession(
      pinnedSession([
        row({ id: "p-shared", scopeId: SHARED, approverRoles: ["admin"] }),
        row({
          id: "p-org-github",
          scopeId: ORG,
          connectorKey: "github",
          approverRoles: ["owner"],
          allowRequesterApproval: true,
        }),
      ]),
      "github",
    );

    expect(routing).toMatchObject({
      approverRoles: ["owner"],
      allowRequesterApproval: true,
      source: { kind: "policy", policyId: "p-org-github" },
    });
  });

  it("falls back to the scope kind's defaults when the snapshot holds no rows", () => {
    expect(routingForSession(pinnedSession([]))).toEqual({
      approverRoles: ["admin", "owner"],
      allowRequesterApproval: true,
      source: { kind: "default", scopeKind: "shared" },
    });
    expect(routingForSession(pinnedSession([], "personal"))).toEqual({
      approverRoles: ["owner"],
      allowRequesterApproval: true,
      source: { kind: "default", scopeKind: "personal" },
    });
  });

  it("refuses a session that carries no snapshot at all", () => {
    expect(() => routingForSession(pinnedSession(null))).toThrow(ApprovalValidationError);
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
