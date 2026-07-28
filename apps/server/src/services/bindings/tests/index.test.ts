import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import {
  createBinding,
  resolveLocation,
  SurfaceNotBindableError,
  UnknownSurfaceError,
} from "#server/services/bindings/index.js";

const db = new Proxy(
  {},
  {
    get() {
      throw new Error("surface validation must not query the database");
    },
  },
) as Database;

describe("createBinding", () => {
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

describe("resolveLocation", () => {
  it("refuses a direct location that names somebody other than its requester", async () => {
    // The caller supplies the location ref, so a service credential could
    // otherwise claim a member's chat — and, once a row existed, keep that
    // member out of it. The refusal is a lookup, before any query runs.
    await expect(
      resolveLocation(db, {
        orgId: "org",
        surface: "web",
        locationRef: "principal-a",
        dm: { principal: { id: "principal-b", displayName: "Mallory" } },
      }),
    ).resolves.toEqual({ kind: "unbound" });
  });
});
