import { fixtures } from "@trema/projection/testing";
import { describe, expect, it } from "vitest";
import { advance, fold } from "#projection/fold.js";

// The core requirement: the incremental path and the batch path agree at
// every possible cursor, because a live tail is nothing but repeated advance.
describe("incremental ≡ batch", () => {
  for (const fixture of fixtures) {
    it(`holds for every split point of ${fixture.name}`, () => {
      const batch = fold(fixture.runId, fixture.events);

      for (let split = 0; split <= fixture.events.length; split += 1) {
        const first = fold(fixture.runId, fixture.events.slice(0, split));
        const advanced = advance(first, fixture.events.slice(split));
        expect(advanced).toStrictEqual(batch);
      }
    });

    it(`holds under one-event advances of ${fixture.name}`, () => {
      const batch = fold(fixture.runId, fixture.events);

      let projection = fold(fixture.runId, []);
      for (const event of fixture.events) {
        projection = advance(projection, [event]);
      }
      expect(projection).toStrictEqual(batch);
    });
  }
});
