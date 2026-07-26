import { describe, expect, it } from "vitest";

import { mergeCatalog } from "#server/services/model-providers/catalog.js";

const nothingPinned = new Set<string>();

describe("mergeCatalog", () => {
  it("imports what the provider lists and defaults the roles it can", () => {
    expect(
      mergeCatalog({
        stored: [],
        listed: [
          { id: "plain-model" },
          { id: "stated-vectors", embedding: true },
          { id: "embed-in-name-only", embedding: false },
          { id: "voyage-3" },
        ],
        pinned: nothingPinned,
      }),
    ).toEqual([
      { id: "embed-in-name-only" },
      { id: "plain-model" },
      { id: "stated-vectors", roles: ["embed"] },
      { id: "voyage-3", roles: ["embed"] },
    ]);
  });

  it("leaves a stored entry exactly as the admin left it", () => {
    const stored = {
      id: "big-model",
      label: "Big model",
      roles: ["turns" as const],
      contextWindow: 8,
    };
    expect(
      mergeCatalog({
        stored: [stored],
        // The listing would import this one as an embedder if it were new.
        listed: [{ id: "big-model", embedding: true }],
        pinned: nothingPinned,
      }),
    ).toEqual([stored]);
  });

  it("drops an imported entry the listing no longer names and keeps every other kind", () => {
    expect(
      mergeCatalog({
        stored: [
          { id: "forgotten" },
          { id: "labelled", label: "Named by hand" },
          { id: "sized", contextWindow: 4096 },
          { id: "roled", roles: ["utility"] },
          { id: "assigned" },
          // An empty role list is what an admin clearing every role leaves, and
          // it means unrestricted — the same thing saying nothing means.
          { id: "cleared", roles: [] },
        ],
        listed: [],
        pinned: new Set(["assigned"]),
      }),
    ).toEqual([
      { id: "assigned" },
      { id: "labelled", label: "Named by hand" },
      { id: "roled", roles: ["utility"] },
      { id: "sized", contextWindow: 4096 },
    ]);
  });
});
