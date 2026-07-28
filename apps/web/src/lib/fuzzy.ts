/**
 * Fuzzy matching for the model lists. A catalog holds hundreds of ids full of
 * dashes and version suffixes, so a plain substring match makes the searcher
 * type the punctuation; a subsequence match lets "gpt4m" reach "gpt-4o-mini"
 * and "snet" reach "sonnet". Scoring is deliberately small — subsequence with
 * bonuses — not a ranking library.
 */

/** Characters that end a segment, so the next character starts one. */
const separators = new Set([" ", "-", "_", "/", ".", ":"]);

/**
 * Scores how well `query` matches `candidate`, or undefined when it does not.
 * Matching is case-insensitive and greedy left to right: every query character
 * must appear in the candidate in order. Each hit scores one point, plus two
 * for extending a consecutive run and three for landing on a segment start
 * (the head of the string, or right after a separator) — so matches that read
 * like the candidate's own words outrank ones scattered across it. A sliver of
 * the score is docked per candidate character, so of two equally good matches
 * the shorter, more exact candidate wins.
 */
export function fuzzyScore(query: string, candidate: string): number | undefined {
  const q = query.toLowerCase();
  const c = candidate.toLowerCase();
  let score = 0;
  let previous = -2;
  let j = 0;
  for (let i = 0; i < c.length && j < q.length; i++) {
    if (c[i] !== q[j]) continue;
    score += 1;
    if (i === previous + 1) score += 2;
    const before = c[i - 1];
    if (i === 0 || (before !== undefined && separators.has(before))) score += 3;
    previous = i;
    j++;
  }
  if (j < q.length) return undefined;
  // The length dock stays well under one point, so it only ever breaks ties —
  // it never outweighs a run or segment bonus.
  return score - c.length / 1000;
}

/**
 * Scores a query against a set of fields. The query splits on whitespace and
 * every word must fuzzy-match at least one field — each scored by its best
 * field, summed — so "sonnet anthropic" narrows by model and provider at once.
 * Returns undefined when any word matches nothing, and zero for the empty
 * query, which matches everything and ranks nothing.
 */
export function fuzzyMatch(query: string, fields: readonly string[]): number | undefined {
  const words = query
    .trim()
    .split(/\s+/)
    .filter((word) => word !== "");
  let total = 0;
  for (const word of words) {
    let best: number | undefined;
    for (const field of fields) {
      const score = fuzzyScore(word, field);
      if (score !== undefined && (best === undefined || score > best)) best = score;
    }
    if (best === undefined) return undefined;
    total += best;
  }
  return total;
}
