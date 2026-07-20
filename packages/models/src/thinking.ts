import type { ThinkingLevel } from "@trema/harness";
import type { ModelEndpoint } from "./endpoints.js";
import type { SdkProviderOptions } from "./sdk-operations.js";

export interface ThinkingSupport {
  /** Levels this model is explicitly configured to accept. */
  supportedLevels: readonly ThinkingLevel[];
}

/** Keys are model-id patterns. `*` matches any sequence; insertion order wins. */
export type ThinkingLevelMap = Record<string, ThinkingSupport>;

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
  }

  return undefined;
}
