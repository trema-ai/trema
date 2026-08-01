import { rpcClient } from "#web/lib/api.ts";

/**
 * The shared write seam for run controls: one submit helper and the small
 * error readers the acknowledgement rules depend on.
 */

export type SubmitIntentInput = Parameters<typeof rpcClient.intents.submit>[0];
export type RunControlIntent = Exclude<SubmitIntentInput["intent"], { type: "message" }>;

/** Submits one intent under a freshly minted id. */
export function submitIntent(intent: RunControlIntent) {
  return rpcClient.intents.submit({ intentId: crypto.randomUUID(), intent });
}

/** The structured code the intent endpoint attaches to a refusal, if any. */
export function intentErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

export function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
