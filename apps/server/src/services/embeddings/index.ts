import { createSdkEmbeddingPort } from "@trema/models";

import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { resolveEndpoints, resolveRoleChain } from "#server/services/model-providers/index.js";

/**
 * A source of vectors, named by the model that produces them. Callers store
 * the name alongside each vector so a later model change is detectable.
 */
export interface Embedder {
  model: string;
  embed(texts: string[]): Promise<number[][]>;
}

/**
 * How a caller reaches the organization's embedder. The running server passes
 * `masterKey` so the stored API key can be decrypted. Tests pass `embedder` to
 * replace the transport without reaching an endpoint.
 */
export interface EmbeddingOptions {
  embedder?: Embedder;
  masterKey?: string;
}

/**
 * Whether the `embed` role is assigned at all, regardless of whether anything
 * it names can still be reached.
 *
 * Role defaults outlive the providers they name, so this is a different
 * question from "can this organization embed" — and the two answers are what
 * separate an organization that never configured embeddings from one whose
 * provider was deleted underneath it.
 */
export async function hasEmbedAssignment(db: Database, orgId: string): Promise<boolean> {
  return (await resolveRoleChain(db, orgId, "embed")).length > 0;
}

/**
 * Builds the organization's embedder, or returns undefined when no usable
 * provider serves the `embed` role. An unconfigured role is the off state, not
 * a failure: search stays lexical and items keep a null vector.
 */
export async function resolveEmbedder(
  db: Database,
  orgId: string,
  options: EmbeddingOptions = {},
): Promise<Embedder | undefined> {
  // The role default is the only switch. An injected embedder replaces the
  // transport, never the decision to embed at all.
  const chain = await resolveRoleChain(db, orgId, "embed");
  if (chain.length === 0) return undefined;
  if (options.embedder) return options.embedder;

  const endpoints = await resolveEndpoints(db, orgId, {
    ...(options.masterKey === undefined ? {} : { masterKey: options.masterKey }),
  });
  // Only a protocol the embedding port speaks counts as usable, so a chain
  // entry pointing at a turns-only protocol falls through rather than failing.
  const entry = chain.find(
    (candidate) => endpoints[candidate.providerName]?.protocol === "openai-compatible",
  );
  const endpoint = entry === undefined ? undefined : endpoints[entry.providerName];
  if (entry === undefined || endpoint?.protocol !== "openai-compatible") {
    log.warn("Embed role resolves to no usable provider", { orgId });
    return undefined;
  }

  const port = createSdkEmbeddingPort({ endpoint });
  return {
    model: entry.modelId,
    embed: async (texts) => (await port.embed({ model: entry.modelId, input: texts })).vectors,
  };
}
