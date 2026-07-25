import { describe, expect, it } from "vitest";
import type { RunState } from "#harness/core/run-state.js";
import { canTransition, LEGAL_RUN_STATE_TRANSITIONS, RUN_STATES } from "#harness/core/run-state.js";

const expectedTransitions = new Set<string>([
  "queued:running",
  "running:awaiting_approval",
  "running:awaiting_input",
  "running:completed",
  "running:failed",
  "running:cancelled",
  "awaiting_approval:running",
  "awaiting_approval:stale",
  "awaiting_input:running",
  "awaiting_input:stale",
]);

describe("the run state transition table", () => {
  it("has an entry for every run state", () => {
    expect(Object.keys(LEGAL_RUN_STATE_TRANSITIONS).sort()).toEqual([...RUN_STATES].sort());
  });

  it.each(RUN_STATES.flatMap((from) => RUN_STATES.map((to) => [from, to] as const)))(
    "classifies %s -> %s",
    (from: RunState, to: RunState) => {
      expect(canTransition(from, to)).toBe(expectedTransitions.has(`${from}:${to}`));
    },
  );

  it("contains exactly the legal edges", () => {
    const actual = new Set(
      RUN_STATES.flatMap((from) => LEGAL_RUN_STATE_TRANSITIONS[from].map((to) => `${from}:${to}`)),
    );

    expect(actual).toEqual(expectedTransitions);
  });
});
