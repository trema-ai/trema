import { describe, expect, it } from "vitest";
import { fold } from "#projection/fold.js";
import { fixtures } from "./fixtures.js";

// The projection is the contract: every consumer folds through one code path,
// so a chat/run-view discrepancy must be provably a renderer bug.
describe("golden folds", () => {
  it.each(fixtures.map((fixture) => [fixture.name, fixture] as const))(
    "folds %s to its checked-in projection",
    (_name, fixture) => {
      expect(fold(fixture.runId, fixture.events)).toStrictEqual(fixture.expected);
    },
  );
});
