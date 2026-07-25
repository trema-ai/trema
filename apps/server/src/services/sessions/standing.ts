import type { ItemKind } from "#server/generated/prisma/client.js";

/** The default standing budget, in tokens, when configuration supplies none. */
export const DEFAULT_STANDING_BUDGET_TOKENS = 4000;

/** One standing rule as the harness injects it. */
export interface StandingRule {
  id: string;
  type: string;
  content: string;
}

export interface StandingSkill {
  name: string;
  description: string;
}

/** The bounded injection set a session hands to the harness. */
export interface StandingSet {
  instructions: string;
  rules: StandingRule[];
  skillIndex: StandingSkill[];
}

/** An active standing item in the session's scope chain. */
export interface StandingCandidate {
  id: string;
  scopeId: string;
  kind: ItemKind;
  version: number;
  body: unknown;
  lastUsedAt: Date | null;
  updatedAt: Date;
}

export interface AssembledStanding {
  standing: StandingSet;
  budgetTokens: number;
  usedTokens: number;
  /** Items injected into the session, in injection order. */
  included: Array<{ id: string; version: number }>;
  /**
   * Items the budget cut. They stay reachable through search, so nothing is
   * lost; they are only not injected.
   */
  overflowItemIds: string[];
}

export interface AssembleStandingInput {
  /** Scope IDs in resolution order, widest first. */
  scopeChain: readonly string[];
  budgetTokens?: number;
}

/**
 * Estimate the token cost of a text. Four characters per token is the usual
 * rule of thumb; the budget is a guardrail, not an accounting record.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function bodyContent(body: unknown): string {
  if (typeof body === "object" && body !== null && "content" in body) {
    const { content } = body as { content: unknown };
    if (typeof content === "string") return content;
  }
  return "";
}

function bodyType(body: unknown): string {
  if (typeof body === "object" && body !== null && "type" in body) {
    const { type } = body as { type: unknown };
    if (typeof type === "string") return type;
  }
  return "rule";
}

// Most-recently-reinforced first. Retrieval bumps `lastUsedAt`, so it is the
// reinforcement signal; an item never used yet falls back to its last edit.
function byReinforcement(left: StandingCandidate, right: StandingCandidate): number {
  const leftUsed = left.lastUsedAt?.getTime() ?? 0;
  const rightUsed = right.lastUsedAt?.getTime() ?? 0;
  if (leftUsed !== rightUsed) return rightUsed - leftUsed;
  const edited = right.updatedAt.getTime() - left.updatedAt.getTime();
  if (edited !== 0) return edited;
  return left.id.localeCompare(right.id);
}

/**
 * Assemble the standing set under the token budget.
 *
 * Instructions come first and whole: each scope holds at most one, and the
 * chain's are concatenated widest to narrowest, so a narrower scope refines
 * the wider one instead of replacing it. Rules then fill the remaining budget,
 * most-recently-reinforced first, and the assembly stops at the first rule
 * that does not fit. Everything after that cut falls back to retrieval.
 */
export function assembleStanding(
  candidates: readonly StandingCandidate[],
  input: AssembleStandingInput,
): AssembledStanding {
  const budgetTokens = input.budgetTokens ?? DEFAULT_STANDING_BUDGET_TOKENS;
  const chainOrder = new Map(input.scopeChain.map((scopeId, index) => [scopeId, index]));

  const instructionItems = candidates
    .filter((candidate) => candidate.kind === "instruction")
    .sort(
      (left, right) =>
        (chainOrder.get(left.scopeId) ?? Number.MAX_SAFE_INTEGER) -
        (chainOrder.get(right.scopeId) ?? Number.MAX_SAFE_INTEGER),
    );
  const ruleItems = candidates
    .filter((candidate) => candidate.kind !== "instruction")
    .sort(byReinforcement);

  const instructions = instructionItems
    .map((item) => bodyContent(item.body).trim())
    .filter((content) => content.length > 0)
    .join("\n\n");

  const included: Array<{ id: string; version: number }> = instructionItems.map((item) => ({
    id: item.id,
    version: item.version,
  }));
  const overflowItemIds: string[] = [];
  const rules: StandingRule[] = [];
  let usedTokens = estimateTokens(instructions);
  let cut = false;

  for (const item of ruleItems) {
    const content = bodyContent(item.body).trim();
    const cost = estimateTokens(content);
    if (cut || usedTokens + cost > budgetTokens) {
      cut = true;
      overflowItemIds.push(item.id);
      continue;
    }
    usedTokens += cost;
    rules.push({ id: item.id, type: bodyType(item.body), content });
    included.push({ id: item.id, version: item.version });
  }

  return {
    // The skill index joins the standing set when skills land.
    standing: { instructions, rules, skillIndex: [] },
    budgetTokens,
    usedTokens,
    included,
    overflowItemIds,
  };
}
