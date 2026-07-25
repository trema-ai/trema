import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import { createBinding, UnknownSurfaceError } from "#server/services/bindings/index.js";

describe("createBinding", () => {
  it("rejects an unknown surface before querying the database", async () => {
    const db = new Proxy(
      {},
      {
        get() {
          throw new Error("unknown surface validation must not query the database");
        },
      },
    ) as Database;

    await expect(
      createBinding(db, {
        orgId: "org",
        actorPrincipalId: "principal",
        surface: "discord",
        locationRef: "server:channel",
        scopeId: "scope",
      }),
    ).rejects.toEqual(new UnknownSurfaceError("Unknown surface: discord"));
  });
});
