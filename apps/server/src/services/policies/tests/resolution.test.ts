import { describe, expect, it } from "vitest";

import {
  DEFAULT_MODE_CEILING,
  type PolicyRow,
  resolveApprovalRouting,
  resolveEffectiveMode,
  resolveModeCeiling,
  strictestMode,
} from "#server/services/policies/index.js";

const ORG = "scope-org";
const SHARED = "scope-shared";

function row(overrides: Partial<PolicyRow> & Pick<PolicyRow, "id" | "scopeId" | "maxMode">) {
  return {
    connectorKey: null,
    approverRoles: ["admin"],
    allowRequesterApproval: false,
    ...overrides,
  } satisfies PolicyRow;
}

describe("strictestMode", () => {
  it("orders ask under delegated under full", () => {
    expect(strictestMode("ask", "full")).toBe("ask");
    expect(strictestMode("full", "ask")).toBe("ask");
    expect(strictestMode("delegated", "full")).toBe("delegated");
    expect(strictestMode("full", "full")).toBe("full");
  });
});

describe("mode ceiling resolution", () => {
  it("falls back to the default ceiling when no scope in the chain carries a row", () => {
    const ceiling = resolveModeCeiling({ rows: [], scopeChain: [ORG, SHARED] });

    expect(ceiling).toBe(DEFAULT_MODE_CEILING);
    expect(ceiling).toBe("delegated");
  });

  it("grants full only where a row explicitly wrote it", () => {
    const ceiling = resolveModeCeiling({
      rows: [row({ id: "p-org", scopeId: ORG, maxMode: "full" })],
      scopeChain: [ORG, SHARED],
    });

    expect(ceiling).toBe("full");
  });

  it("lets the most restrictive applicable row win across the chain", () => {
    const ceiling = resolveModeCeiling({
      rows: [
        row({ id: "p-org", scopeId: ORG, maxMode: "full" }),
        row({ id: "p-shared", scopeId: SHARED, maxMode: "ask" }),
      ],
      scopeChain: [ORG, SHARED],
    });

    expect(ceiling).toBe("ask");
  });

  it("lets a wider scope tighten a narrower scope's row too", () => {
    const ceiling = resolveModeCeiling({
      rows: [
        row({ id: "p-org", scopeId: ORG, maxMode: "delegated" }),
        row({ id: "p-shared", scopeId: SHARED, maxMode: "full" }),
      ],
      scopeChain: [ORG, SHARED],
    });

    expect(ceiling).toBe("delegated");
  });

  it("ignores rows from scopes outside the chain", () => {
    const ceiling = resolveModeCeiling({
      rows: [row({ id: "p-other", scopeId: "scope-elsewhere", maxMode: "ask" })],
      scopeChain: [ORG, SHARED],
    });

    expect(ceiling).toBe(DEFAULT_MODE_CEILING);
  });

  it("tightens a trusted connector's ceiling with its own row", () => {
    const ceiling = resolveModeCeiling({
      rows: [
        row({ id: "p-org", scopeId: ORG, maxMode: "full" }),
        row({ id: "p-github", scopeId: ORG, connectorKey: "github", maxMode: "ask" }),
      ],
      scopeChain: [ORG, SHARED],
      connectorKey: "github",
      connectorTrusted: true,
    });

    expect(ceiling).toBe("ask");
  });

  it("ignores another connector's rows", () => {
    const ceiling = resolveModeCeiling({
      rows: [
        row({ id: "p-org", scopeId: ORG, maxMode: "full" }),
        row({ id: "p-slack", scopeId: ORG, connectorKey: "slack", maxMode: "ask" }),
      ],
      scopeChain: [ORG, SHARED],
      connectorKey: "github",
      connectorTrusted: true,
    });

    expect(ceiling).toBe("full");
  });

  it("ignores connector-specific rows when the call reaches no connector", () => {
    const ceiling = resolveModeCeiling({
      rows: [row({ id: "p-github", scopeId: ORG, connectorKey: "github", maxMode: "ask" })],
      scopeChain: [ORG, SHARED],
    });

    expect(ceiling).toBe(DEFAULT_MODE_CEILING);
  });

  it("pins an untrusted connector to ask no matter what policy grants", () => {
    const rows = [
      row({ id: "p-org", scopeId: ORG, maxMode: "full" }),
      row({ id: "p-mcp", scopeId: ORG, connectorKey: "custom-mcp", maxMode: "full" }),
    ];

    expect(
      resolveModeCeiling({
        rows,
        scopeChain: [ORG, SHARED],
        connectorKey: "custom-mcp",
        connectorTrusted: false,
      }),
    ).toBe("ask");
    // Unstated trust is not trust.
    expect(
      resolveModeCeiling({ rows, scopeChain: [ORG, SHARED], connectorKey: "custom-mcp" }),
    ).toBe("ask");
  });
});

describe("approval routing resolution", () => {
  it("falls back to the scope kind's defaults when no row applies", () => {
    const routing = resolveApprovalRouting({
      rows: [],
      scopeChain: [ORG, SHARED],
      scopeKind: "shared",
    });

    expect(routing).toEqual({
      approverRoles: ["admin", "owner"],
      allowRequesterApproval: true,
      source: { kind: "default", scopeKind: "shared" },
    });
  });

  it("lets the narrowest scope-wide row win over a wider one", () => {
    const routing = resolveApprovalRouting({
      rows: [
        row({ id: "p-org", scopeId: ORG, maxMode: "ask", approverRoles: ["owner"] }),
        row({ id: "p-shared", scopeId: SHARED, maxMode: "ask", approverRoles: ["admin"] }),
      ],
      scopeChain: [ORG, SHARED],
      scopeKind: "shared",
    });

    expect(routing).toMatchObject({
      approverRoles: ["admin"],
      source: { kind: "policy", policyId: "p-shared" },
    });
  });

  it("lets a connector-specific row beat a narrower scope-wide row", () => {
    const routing = resolveApprovalRouting({
      rows: [
        row({ id: "p-shared", scopeId: SHARED, maxMode: "ask", approverRoles: ["admin"] }),
        row({
          id: "p-org-github",
          scopeId: ORG,
          connectorKey: "github",
          maxMode: "ask",
          approverRoles: ["owner"],
          allowRequesterApproval: true,
        }),
      ],
      scopeChain: [ORG, SHARED],
      scopeKind: "shared",
      connectorKey: "github",
    });

    expect(routing).toMatchObject({
      approverRoles: ["owner"],
      allowRequesterApproval: true,
      source: { kind: "policy", policyId: "p-org-github" },
    });
  });

  it("prefers the narrower scope among connector-specific rows", () => {
    const routing = resolveApprovalRouting({
      rows: [
        row({
          id: "p-org-github",
          scopeId: ORG,
          connectorKey: "github",
          maxMode: "ask",
          approverRoles: ["owner"],
        }),
        row({
          id: "p-shared-github",
          scopeId: SHARED,
          connectorKey: "github",
          maxMode: "ask",
          approverRoles: ["admin"],
        }),
      ],
      scopeChain: [ORG, SHARED],
      scopeKind: "shared",
      connectorKey: "github",
    });

    expect(routing.source).toEqual({ kind: "policy", policyId: "p-shared-github" });
  });

  it("skips connector-specific rows when the call reaches no connector", () => {
    const routing = resolveApprovalRouting({
      rows: [
        row({
          id: "p-org-github",
          scopeId: ORG,
          connectorKey: "github",
          maxMode: "ask",
          approverRoles: ["owner"],
        }),
      ],
      scopeChain: [ORG, SHARED],
      scopeKind: "shared",
    });

    expect(routing.source).toEqual({ kind: "default", scopeKind: "shared" });
  });
});

describe("effective mode resolution", () => {
  it("clamps the requested mode to the ceiling", () => {
    const mode = resolveEffectiveMode({
      rows: [],
      scopeChain: [ORG, SHARED],
      requestedMode: "full",
      classifierAvailable: true,
    });

    // No row grants full, so the default ceiling holds.
    expect(mode).toBe("delegated");
  });

  it("keeps a stricter request under a looser ceiling", () => {
    const mode = resolveEffectiveMode({
      rows: [row({ id: "p-org", scopeId: ORG, maxMode: "full" })],
      scopeChain: [ORG, SHARED],
      requestedMode: "ask",
      classifierAvailable: true,
    });

    expect(mode).toBe("ask");
  });

  it("runs full where policy grants it, with or without a classifier", () => {
    const input = {
      rows: [row({ id: "p-org", scopeId: ORG, maxMode: "full" })],
      scopeChain: [ORG, SHARED],
      requestedMode: "full",
    } as const;

    expect(resolveEffectiveMode({ ...input, classifierAvailable: true })).toBe("full");
    expect(resolveEffectiveMode({ ...input, classifierAvailable: false })).toBe("full");
  });

  it("degrades delegated to ask when no classifier is configured", () => {
    const mode = resolveEffectiveMode({
      rows: [],
      scopeChain: [ORG, SHARED],
      requestedMode: "delegated",
      classifierAvailable: false,
    });

    expect(mode).toBe("ask");
  });

  it("degrades a delegated clamp too, not only a delegated request", () => {
    const mode = resolveEffectiveMode({
      rows: [row({ id: "p-org", scopeId: ORG, maxMode: "delegated" })],
      scopeChain: [ORG, SHARED],
      requestedMode: "full",
      classifierAvailable: false,
    });

    expect(mode).toBe("ask");
  });

  it("pins an untrusted connector's call to ask regardless of the request", () => {
    const mode = resolveEffectiveMode({
      rows: [row({ id: "p-org", scopeId: ORG, maxMode: "full" })],
      scopeChain: [ORG, SHARED],
      connectorKey: "custom-mcp",
      connectorTrusted: false,
      requestedMode: "full",
      classifierAvailable: true,
    });

    expect(mode).toBe("ask");
  });
});
