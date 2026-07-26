import { createSdkEmbeddingPort } from "@trema/models";

import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  ModelProviderValidationError,
  putDefaults,
  putProvider,
  resolveEndpoints,
  resolveRoleChain,
} from "#server/services/model-providers/index.js";

/**
 * The provider the embedding settings write to when the `embed` role names
 * none yet. An organization that assigns `embed` from the Models screen keeps
 * whatever provider it picked — this name only fills the blank.
 */
export const EMBEDDINGS_PROVIDER_NAME = "embeddings";

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

export class EmbeddingSettingsValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "EmbeddingSettingsValidationError";
  }
}

export class EmbeddingSettingsNotFoundError extends Error {
  constructor() {
    super("Embedding settings not found");
    this.name = "EmbeddingSettingsNotFoundError";
  }
}

/** The `embed` role as the legacy settings screen sees it: one endpoint, one model. */
export interface EmbeddingSettings {
  providerName: string;
  endpoint: string;
  model: string;
  hasApiKey: boolean;
  updatedAt: Date;
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
 * Reads the `embed` role as a settings row.
 *
 * The registry can express more than this screen can — a fallback chain, a
 * provider shared with `turns` — so this reports the first chain entry whose
 * provider still exists, which is the one the embedder would use, and phase 3's
 * Models screen shows the rest.
 */
export async function getEmbeddingSettings(
  db: Database,
  orgId: string,
): Promise<EmbeddingSettings | null> {
  const chain = await resolveRoleChain(db, orgId, "embed");
  if (chain.length === 0) return null;

  const providers = await db.modelProvider.findMany({
    where: { orgId, name: { in: chain.map((entry) => entry.providerName) } },
  });
  for (const entry of chain) {
    const provider = providers.find((candidate) => candidate.name === entry.providerName);
    if (provider === undefined) continue;
    return {
      providerName: provider.name,
      endpoint: provider.baseUrl,
      model: entry.modelId,
      hasApiKey: provider.credentialCiphertext !== null,
      updatedAt: provider.updatedAt,
    };
  }
  return null;
}

export interface PutEmbeddingSettingsInput {
  orgId: string;
  endpoint: string;
  model: string;
  /** Omit to keep the stored key. `null` clears it, for an endpoint with no key. */
  apiKey?: string | null;
  masterKey?: string;
}

/**
 * Points the `embed` role at an endpoint and a model.
 *
 * It edits whichever provider the role already names, so an organization that
 * assigned `embed` to a shared provider is not silently moved onto a second
 * row; only an unassigned role gets the reserved name.
 */
export async function putEmbeddingSettings(
  db: Database,
  input: PutEmbeddingSettingsInput,
): Promise<EmbeddingSettings> {
  const model = input.model.trim();
  if (!model) throw new EmbeddingSettingsValidationError("Embedding model cannot be empty");

  const existing = await getEmbeddingSettings(db, input.orgId);
  const providerName = existing?.providerName ?? EMBEDDINGS_PROVIDER_NAME;
  // An omitted key means "keep the stored one" on an existing provider and "no
  // key at all" on a new one, which is what this screen has always meant by
  // leaving it out.
  const credential =
    typeof input.apiKey === "string"
      ? { credentialMode: "api_key" as const, credential: input.apiKey }
      : input.apiKey === null || existing === null
        ? { credentialMode: "none" as const }
        : {};

  try {
    await db.$transaction(async (transaction) => {
      await putProvider(transaction, {
        orgId: input.orgId,
        name: providerName,
        label: providerName,
        protocol: "openai_compatible",
        baseUrl: input.endpoint,
        ...credential,
        ...(input.masterKey === undefined ? {} : { masterKey: input.masterKey }),
      });
      await putDefaults(transaction, {
        orgId: input.orgId,
        role: "embed",
        chain: [{ providerName, modelId: model }],
      });
    });
  } catch (error) {
    // The registry's validation is this screen's validation; only the sentence
    // changes, because the screen says "endpoint" where the registry says
    // "provider base URL".
    if (error instanceof ModelProviderValidationError) {
      throw new EmbeddingSettingsValidationError(
        error.message.replace("Provider base URL", "Embedding endpoint"),
      );
    }
    throw error;
  }

  log.info("Embedding settings updated", { providerName, model });
  const saved = await getEmbeddingSettings(db, input.orgId);
  if (saved === null) throw new EmbeddingSettingsNotFoundError();
  return saved;
}

/**
 * Unassigns the `embed` role. The provider row stays: it is a registry entry
 * that other roles may use, and turning embeddings off is a statement about the
 * role, not about the endpoint.
 */
export async function deleteEmbeddingSettings(db: Database, orgId: string): Promise<void> {
  const deleted = await db.modelDefault.deleteMany({ where: { orgId, role: "embed" } });
  if (deleted.count === 0) throw new EmbeddingSettingsNotFoundError();
  log.info("Embedding settings deleted", { orgId });
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
