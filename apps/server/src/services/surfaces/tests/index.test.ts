import { describe, expect, it } from "vitest";

import {
  getSurface,
  isKnownSurface,
  isLocationBindable,
  surfaceCatalog,
} from "#server/services/surfaces/index.js";

describe("surfaceCatalog", () => {
  it("carries web as a built-in surface with no bindable locations", () => {
    expect(getSurface("web")).toEqual({
      id: "web",
      name: "Web",
      status: "available",
      builtIn: true,
      locationBindable: false,
    });
    expect(isKnownSurface("web")).toBe(true);
    expect(isLocationBindable("web")).toBe(false);
  });

  it("keeps every other surface location-bindable", () => {
    for (const surface of surfaceCatalog) {
      if (surface.id === "web") continue;
      expect(isLocationBindable(surface.id)).toBe(true);
    }
  });

  it("treats an unknown surface as neither known nor bindable", () => {
    expect(isKnownSurface("discord")).toBe(false);
    expect(getSurface("discord")).toBeUndefined();
    expect(isLocationBindable("discord")).toBe(false);
  });
});
