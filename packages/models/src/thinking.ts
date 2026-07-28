import type { ThinkingLevel } from "@trema/harness";
import type { ModelEndpoint } from "./endpoints.js";
import type { SdkProviderOptions } from "./sdk-operations.js";

/** Thinking levels that one model pattern explicitly allows. */
export interface ThinkingSupport {
  /** Levels this model is explicitly configured to accept. */
  supportedLevels: readonly ThinkingLevel[];
}

/** Keys are model-id patterns. `*` matches any sequence; insertion order wins. */
export type ThinkingLevelMap = Record<string, ThinkingSupport>;

/**
 * What each level buys on the Anthropic protocol, which takes a token budget
 * where the OpenAI-compatible one takes a word. The API refuses a budget under
 * 1024, so the lowest level clears that floor with room, every step is a
 * multiple of the one below it, and the top stays inside the output ceiling of
 * the models this protocol serves. The budget is added to a request's output
 * allowance rather than taken out of it.
 *
 * The Bedrock arm reads the same table: it fronts the same models under another
 * option name, so the numbers are shared rather than copied.
 */
const anthropicThinkingBudgets: Record<Exclude<ThinkingLevel, "off">, number> = {
  low: 4096,
  medium: 16_384,
  high: 32_768,
};

/**
 * What each level buys on the Google protocol, which also takes a token budget.
 * A budget stated here is sent as written — the provider clamps only the budget
 * it derives itself — so the table stays inside the narrowest limits the Gemini
 * family imposes: above the 512-token floor its smallest thinking models refuse
 * to go under, and no higher than the 24,576-token ceiling the Flash models
 * cap at, which the larger Pro ceiling of 32,768 comfortably contains. Every
 * step is a multiple of the one below it.
 *
 * The Vertex arm reads the same table: it fronts the same Gemini models under
 * another options key, so the numbers are shared rather than copied.
 */
const googleThinkingBudgets: Record<Exclude<ThinkingLevel, "off">, number> = {
  low: 2048,
  medium: 8192,
  high: 24_576,
};

function matches(pattern: string, modelId: string): boolean {
  const escaped = pattern.replace(/[|\\{}()[\]^$+?.]/g, "\\$&").replaceAll("*", ".*");
  return new RegExp(`^${escaped}$`).test(modelId);
}

function configuredLevel(
  map: ThinkingLevelMap | undefined,
  modelId: string,
  requested: ThinkingLevel | undefined,
): ThinkingLevel {
  if (requested === undefined || requested === "off") return "off";
  const support = Object.entries(map ?? {}).find(([pattern]) => matches(pattern, modelId))?.[1];
  return support?.supportedLevels.includes(requested) === true ? requested : "off";
}

export function thinkingProviderOptions(input: {
  endpointName: string;
  endpoint: ModelEndpoint;
  modelId: string;
  requested?: ThinkingLevel;
  map?: ThinkingLevelMap;
}): SdkProviderOptions | undefined {
  const level = configuredLevel(input.map, input.modelId, input.requested);
  if (level === "off") return undefined;

  switch (input.endpoint.protocol) {
    case "openai-compatible":
      return { [input.endpointName]: { reasoningEffort: level } };
    case "anthropic":
      // Keyed by the provider's own name, not the endpoint's: the Anthropic
      // provider reads its options under `anthropic` whatever a deployment
      // calls the endpoint.
      return {
        anthropic: {
          thinking: { type: "enabled", budgetTokens: anthropicThinkingBudgets[level] },
        },
      };
    case "google":
      // Keyed by the provider's own name for the same reason as above. The
      // thoughts are asked for explicitly: without that flag the model still
      // spends the budget but streams nothing of it, so the run view would
      // record a silence it paid for.
      return {
        google: {
          thinkingConfig: {
            thinkingBudget: googleThinkingBudgets[level],
            includeThoughts: true,
          },
        },
      };
    case "openai-responses":
      // Keyed by the provider's own name for the same reason as above, and the
      // level goes over as the word it already is — this protocol takes an
      // effort, not a budget, so there is nothing to invent. The thoughts need
      // no separate ask: an effort that is not "none" makes the provider
      // request a detailed reasoning summary of its own accord, which is the
      // difference from the Google arm above.
      return { openai: { reasoningEffort: level } };
    case "bedrock":
      // Keyed by the provider's own name for the same reason as above. The
      // budgets are the Anthropic table's, read from it rather than restated:
      // the thinking models this protocol fronts are the same Anthropic models
      // the Anthropic protocol reaches, so a second copy of the numbers could
      // only drift away from the first. What differs is the option's name and
      // its nesting, which is what this arm carries.
      return {
        bedrock: {
          reasoningConfig: { type: "enabled", budgetTokens: anthropicThinkingBudgets[level] },
        },
      };
    case "vertex":
      // Keyed by the provider's own name for the same reason as above, and the
      // name is not this protocol's: the Gemini model behind it looks for
      // `vertex` in the provider's name and then reads `googleVertex` before
      // `vertex`. The budgets are the Google table's, read from it rather than
      // restated, because the models are the same Gemini models reached through
      // another front door. The option's shape is the same too, thoughts asked
      // for and all; only the key it hangs under differs, which is this arm.
      return {
        googleVertex: {
          thinkingConfig: {
            thinkingBudget: googleThinkingBudgets[level],
            includeThoughts: true,
          },
        },
      };
  }

  return undefined;
}
