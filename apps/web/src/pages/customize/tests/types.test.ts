import { describe, expect, it } from "vitest";

import { normalizeConnectorBody } from "#web/pages/customize/types.ts";

describe("connector body normalization", () => {
  const base = {
    catalogKey: "slack",
    connectionId: "00000000-0000-4000-8000-000000000001",
    enabledTools: "all" as const,
  };

  it("defaults legacy connector access to the whole scope", () => {
    expect(normalizeConnectorBody(base)).toEqual({
      ...base,
      access: { kind: "scope" },
    });
  });

  it("retains valid role restrictions and rejects malformed bodies", () => {
    expect(
      normalizeConnectorBody({
        ...base,
        access: { kind: "minimum_role", role: "admin" },
      }),
    ).toMatchObject({ access: { kind: "minimum_role", role: "admin" } });
    expect(normalizeConnectorBody({ ...base, access: { kind: "minimum_role" } })).toBeUndefined();
    expect(normalizeConnectorBody({ ...base, enabledTools: 3 })).toBeUndefined();
  });
});
