import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import {
  createBinding,
  SurfaceNotBindableError,
  UnknownSurfaceError,
} from "#server/services/bindings/index.js";

describe("createBinding", () => {
  const db = new Proxy(
    {},
    {
      get() {
        throw new Error("surface validation must not query the database");
      },
    },
  ) as Database;

  it("rejects an unknown surface before querying the database", async () => {
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

  it("rejects a surface whose locations are not bindable", async () => {
    await expect(
      createBinding(db, {
        orgId: "org",
        actorPrincipalId: "principal",
        surface: "web",
        locationRef: "principal",
        scopeId: "scope",
      }),
    ).rejects.toEqual(new SurfaceNotBindableError("Surface web has no bindable locations"));
  });
});
