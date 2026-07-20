import type { Usage } from "@trema/harness";
import type { LanguageModelUsage, ProviderMetadata } from "ai";

function nonnegativeNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function reportedCost(raw: unknown, metadata?: ProviderMetadata): number {
  const candidates: unknown[] = [];
  if (typeof raw === "object" && raw !== null) {
    const value = raw as Record<string, unknown>;
    candidates.push(value.costUsd, value.cost_usd, value.cost);
  }
  if (metadata !== undefined) {
    for (const value of Object.values(metadata)) {
      if (typeof value === "object" && value !== null) {
        const record = value as Record<string, unknown>;
        candidates.push(record.costUsd, record.cost_usd, record.cost);
      }
    }
  }
  return candidates.map(nonnegativeNumber).find((value) => value !== undefined) ?? 0;
}

export function toUsage(usage?: LanguageModelUsage, metadata?: ProviderMetadata): Usage {
  return {
    inputTokens: usage?.inputTokens ?? 0,
    outputTokens: usage?.outputTokens ?? 0,
    totalTokens: usage?.totalTokens ?? 0,
    cacheReadTokens: usage?.inputTokenDetails.cacheReadTokens ?? 0,
    cacheWriteTokens: usage?.inputTokenDetails.cacheWriteTokens ?? 0,
    costUsd: reportedCost(usage?.raw, metadata),
  };
}
