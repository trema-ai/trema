import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import {
  authorize,
  type Capability,
  capabilities,
  roleAllowsCapability,
  roles,
} from "#server/services/authorize/index.js";

const expected: Record<Capability, Record<(typeof roles)[number], boolean>> = {
  read: { owner: true, admin: true, member: true, viewer: true },
  write_items: { owner: true, admin: true, member: true, viewer: false },
  install_skills: { owner: true, admin: true, member: true, viewer: false },
  manage_connectors: { owner: true, admin: true, member: false, viewer: false },
  manage_scopes: { owner: true, admin: true, member: false, viewer: false },
  edit_policies: { owner: true, admin: true, member: false, viewer: false },
  manage_members: { owner: true, admin: true, member: false, viewer: false },
  read_audit: { owner: true, admin: true, member: false, viewer: false },
  manage_org: { owner: true, admin: false, member: false, viewer: false },
};

describe("capability role table", () => {
  for (const capability of capabilities) {
    for (const role of roles) {
      it(`${role} ${expected[capability][role] ? "may" : "may not"} ${capability}`, () => {
        expect(roleAllowsCapability(role, capability)).toBe(expected[capability][role]);
      });
    }
  }

  it("denies an agent before performing any database lookup", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("agent authorization must not query the database");
        },
      },
    ) as Database;

    for (const capability of capabilities) {
      await expect(
        authorize({ id: "agent", orgId: "org", kind: "agent" }, capability, "scope", db),
      ).resolves.toBe(false);
    }
  });
});
