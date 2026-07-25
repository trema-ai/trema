import { describe, expect, it } from "vitest";

import {
  assembleStanding,
  DEFAULT_STANDING_BUDGET_TOKENS,
  estimateTokens,
  type StandingCandidate,
} from "#server/services/sessions/standing.js";

const orgScopeId = "scope-org";
const sharedScopeId = "scope-shared";

function candidate(overrides: Partial<StandingCandidate> & { id: string }): StandingCandidate {
  return {
    scopeId: sharedScopeId,
    kind: "memory",
    version: 1,
    body: { type: "rule", content: overrides.id },
    lastUsedAt: null,
    updatedAt: new Date("2026-01-01T00:00:00.000Z"),
    ...overrides,
  };
}

describe("standing set assembly", () => {
  it("concatenates instructions widest to narrowest", () => {
    const assembled = assembleStanding(
      [
        candidate({
          id: "narrow",
          kind: "instruction",
          scopeId: sharedScopeId,
          body: { content: "Answer in the team's voice." },
        }),
        candidate({
          id: "wide",
          kind: "instruction",
          scopeId: orgScopeId,
          body: { content: "Never share customer data." },
        }),
      ],
      { scopeChain: [orgScopeId, sharedScopeId] },
    );

    expect(assembled.standing.instructions).toBe(
      "Never share customer data.\n\nAnswer in the team's voice.",
    );
    expect(assembled.standing.rules).toEqual([]);
    expect(assembled.included.map(({ id }) => id)).toEqual(["wide", "narrow"]);
  });

  it("orders rules by reinforcement and cuts the overflow at the budget", () => {
    const long = "x".repeat(400);
    const assembled = assembleStanding(
      [
        candidate({
          id: "stale",
          body: { type: "rule", content: long },
          lastUsedAt: new Date("2026-01-01T00:00:00.000Z"),
        }),
        candidate({
          id: "fresh",
          body: { type: "preference", content: long },
          lastUsedAt: new Date("2026-02-01T00:00:00.000Z"),
        }),
        candidate({ id: "never-used", body: { type: "rule", content: long } }),
      ],
      { scopeChain: [orgScopeId, sharedScopeId], budgetTokens: 150 },
    );

    expect(assembled.standing.rules.map(({ id }) => id)).toEqual(["fresh"]);
    expect(assembled.standing.rules[0]?.type).toBe("preference");
    expect(assembled.overflowItemIds).toEqual(["stale", "never-used"]);
    expect(assembled.usedTokens).toBe(estimateTokens(long));
    expect(assembled.budgetTokens).toBe(150);
  });

  it("keeps every rule when the budget has room", () => {
    const assembled = assembleStanding(
      [
        candidate({ id: "first", lastUsedAt: new Date("2026-03-01T00:00:00.000Z") }),
        candidate({ id: "second", lastUsedAt: new Date("2026-02-01T00:00:00.000Z") }),
      ],
      { scopeChain: [orgScopeId, sharedScopeId] },
    );

    expect(assembled.standing.rules.map(({ id }) => id)).toEqual(["first", "second"]);
    expect(assembled.overflowItemIds).toEqual([]);
    expect(assembled.budgetTokens).toBe(DEFAULT_STANDING_BUDGET_TOKENS);
  });

  it("estimates tokens from text length", () => {
    expect(estimateTokens("")).toBe(0);
    expect(estimateTokens("abcd")).toBe(1);
    expect(estimateTokens("abcde")).toBe(2);
  });
});
