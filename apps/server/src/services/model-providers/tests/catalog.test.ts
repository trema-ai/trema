import { describe, expect, it } from "vitest";

import { mergeCatalog } from "#server/services/model-providers/catalog.js";

const nothingPinned = new Set<string>();

describe("mergeCatalog", () => {
  it("imports what the provider lists, and nothing else about it", () => {
    expect(
      mergeCatalog({
        stored: [],
        listed: [
          { id: "plain-model" },
          { id: "stated-vectors", embedding: true },
          { id: "voyage-3" },
        ],
        pinned: nothingPinned,
      }),
    ).toEqual([{ id: "plain-model" }, { id: "stated-vectors" }, { id: "voyage-3" }]);
  });

  it("leaves a stored entry exactly as the admin left it", () => {
    const stored = {
      id: "big-model",
      label: "Big model",
      offered: true,
      contextWindow: 8,
    };
    expect(
      mergeCatalog({
        stored: [stored],
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
          { id: "picked", offered: true },
          { id: "assigned" },
          // Deselecting a model leaves the flag off, which is the same thing
          // saying nothing means: a refresh may drop it.
          { id: "unpicked", offered: false },
        ],
        listed: [],
        pinned: new Set(["assigned"]),
      }),
    ).toEqual([
      { id: "assigned" },
      { id: "labelled", label: "Named by hand" },
      { id: "picked", offered: true },
      { id: "sized", contextWindow: 4096 },
    ]);
  });
});
