import { createSdkEmbeddingPort } from "@trema/models";
import { decryptEnvelope, encryptEnvelope } from "#/lib/crypto/index.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";

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

function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new EmbeddingSettingsValidationError("Embedding endpoint must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new EmbeddingSettingsValidationError("Embedding endpoint must be an http or https URL");
  }
  return trimmed;
}

export interface PutEmbeddingSettingsInput {
  orgId: string;
  endpoint: string;
  model: string;
  /** Omit to keep the stored key. `null` clears it, for an endpoint with no key. */
  apiKey?: string | null;
  masterKey?: string;
}

export async function putEmbeddingSettings(db: Database, input: PutEmbeddingSettingsInput) {
  const endpoint = normalizeEndpoint(input.endpoint);
  const model = input.model.trim();
  if (!model) throw new EmbeddingSettingsValidationError("Embedding model cannot be empty");

  const apiKeyCiphertext =
    input.apiKey === undefined
      ? undefined
      : input.apiKey === null
        ? null
        : encryptEnvelope(input.apiKey, input.masterKey);

  const settings = await db.embeddingSettings.upsert({
    where: { orgId: input.orgId },
    create: {
      orgId: input.orgId,
      endpoint,
      model,
      ...(apiKeyCiphertext === undefined ? {} : { apiKeyCiphertext }),
    },
    update: {
      endpoint,
      model,
      ...(apiKeyCiphertext === undefined ? {} : { apiKeyCiphertext }),
    },
  });
  log.info("Embedding settings updated", { model: settings.model });
  return settings;
}

export function getEmbeddingSettings(db: Database, orgId: string) {
  return db.embeddingSettings.findUnique({ where: { orgId } });
}

export async function deleteEmbeddingSettings(db: Database, orgId: string): Promise<void> {
  const deleted = await db.embeddingSettings.deleteMany({ where: { orgId } });
  if (deleted.count === 0) throw new EmbeddingSettingsNotFoundError();
  log.info("Embedding settings deleted", { orgId });
}

/**
 * Builds the organization's embedder, or returns undefined when the
 * organization has no settings row. An absent row is the off state, not a
 * failure: search stays lexical and items keep a null vector.
 */
export async function resolveEmbedder(
  db: Database,
  orgId: string,
  options: EmbeddingOptions = {},
): Promise<Embedder | undefined> {
  // The settings row is the only switch. An injected embedder replaces the
  // transport, never the decision to embed at all.
  const settings = await db.embeddingSettings.findUnique({ where: { orgId } });
  if (!settings) return undefined;
  if (options.embedder) return options.embedder;

  const apiKey = settings.apiKeyCiphertext
    ? decryptEnvelope<string>(settings.apiKeyCiphertext, options.masterKey)
    : undefined;
  const port = createSdkEmbeddingPort({
    endpoint: {
      protocol: "openai-compatible",
      baseUrl: settings.endpoint,
      ...(apiKey === undefined ? {} : { apiKey }),
    },
  });

  return {
    model: settings.model,
    embed: async (texts) => (await port.embed({ model: settings.model, input: texts })).vectors,
  };
}
