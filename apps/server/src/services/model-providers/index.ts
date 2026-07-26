import type { ModelEndpoint, ModelEndpoints } from "@trema/models";
import { z } from "zod";
import type {
  ModelCredentialMode,
  ModelDefault,
  ModelProtocol,
  ModelProvider,
  ModelRole,
} from "#server/generated/prisma/client.js";
import { Prisma } from "#server/generated/prisma/client.js";
import { decryptEnvelope, encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";

/**
 * The descriptor protocol each stored protocol resolves to. Prisma enum values
 * cannot carry a hyphen, so this is the whole translation: one line per
 * protocol, added when the protocol's arm lands in `@trema/models`.
 */
const descriptorProtocols: Record<ModelProtocol, ModelEndpoint["protocol"]> = {
  openai_compatible: "openai-compatible",
};

/** One link in a role's fallback chain: a provider by name, and a model on it. */
export interface ModelChainEntry {
  providerName: string;
  modelId: string;
}

const chainSchema = z.array(
  z.object({
    providerName: z.string().trim().min(1),
    modelId: z.string().trim().min(1),
  }),
);

const catalogEntrySchema = z.object({
  id: z.string().trim().min(1),
  label: z.string().trim().min(1).optional(),
  /** The roles this model may serve. Absent means the admin has not said. */
  roles: z.array(z.enum(["turns", "utility", "embed"])).optional(),
  contextWindow: z.number().int().positive().optional(),
});

const catalogSchema = z.array(catalogEntrySchema);

/** One model a provider offers, as the provider describes it. */
export type ModelCatalogEntry = z.infer<typeof catalogEntrySchema>;

const headersSchema = z.record(z.string().trim().min(1), z.string());

export class ModelProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderValidationError";
  }
}

/** Nothing in the registry answers to what the caller named — a provider or a role. */
export class ModelProviderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderNotFoundError";
  }
}

function normalizeBaseUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new ModelProviderValidationError("Provider base URL must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelProviderValidationError("Provider base URL must be an http or https URL");
  }
  return trimmed;
}

/** Reads a stored JSON column back through its schema, or throws if it drifted. */
function parseJsonColumn<T>(schema: z.ZodType<T>, value: Prisma.JsonValue, label: string): T {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ModelProviderValidationError(`Stored ${label} is malformed`);
  }
  return result.data;
}

export function providerHeaders(provider: ModelProvider): Record<string, string> | undefined {
  if (provider.headersJson === null) return undefined;
  return parseJsonColumn(headersSchema, provider.headersJson, "provider headers");
}

export function providerCatalog(provider: ModelProvider): ModelCatalogEntry[] {
  if (provider.catalogJson === null) return [];
  return parseJsonColumn(catalogSchema, provider.catalogJson, "provider catalog");
}

export function defaultChain(row: ModelDefault): ModelChainEntry[] {
  return parseJsonColumn(chainSchema, row.chainJson, "role default");
}

/** A provider as the API renders it: descriptor plus credential status, never the value. */
export interface ModelProviderSummary {
  name: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  headers?: Record<string, string>;
  credentialMode: ModelCredentialMode;
  hasCredential: boolean;
  catalog: ModelCatalogEntry[];
  updatedAt: Date;
}

export function toProviderSummary(provider: ModelProvider): ModelProviderSummary {
  const headers = providerHeaders(provider);
  return {
    name: provider.name,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    ...(headers === undefined ? {} : { headers }),
    credentialMode: provider.credentialMode,
    hasCredential: provider.credentialCiphertext !== null,
    catalog: providerCatalog(provider),
    updatedAt: provider.updatedAt,
  };
}

export interface PutModelProviderInput {
  orgId: string;
  name: string;
  label?: string;
  protocol: ModelProtocol;
  baseUrl: string;
  /** Omit to keep the stored headers; `null` clears them. */
  headers?: Record<string, string> | null;
  credentialMode?: ModelCredentialMode;
  /** Omit to keep the stored credential; `null` clears it. Never read back. */
  credential?: string | null;
  /** Omit to keep the stored catalog; `null` clears it. */
  catalog?: ModelCatalogEntry[] | null;
  masterKey?: string;
}

/**
 * Creates or replaces one provider. The credential is write-only: an omitted
 * value keeps whatever is stored, so an admin can edit a base URL without
 * re-entering a key.
 */
export async function putProvider(
  db: Database,
  input: PutModelProviderInput,
): Promise<ModelProvider> {
  const name = input.name.trim();
  if (!name) throw new ModelProviderValidationError("Provider name cannot be empty");
  const label = (input.label ?? name).trim();
  if (!label) throw new ModelProviderValidationError("Provider label cannot be empty");
  const baseUrl = normalizeBaseUrl(input.baseUrl);

  const existing = await db.modelProvider.findUnique({
    where: { orgId_name: { orgId: input.orgId, name } },
  });
  const credentialMode = input.credentialMode ?? existing?.credentialMode ?? "api_key";

  // A provider with no way to authenticate is a configuration error caught
  // here, not a 401 the run loop discovers three turns in.
  if (credentialMode === "none" && typeof input.credential === "string") {
    throw new ModelProviderValidationError("A provider in none mode cannot carry a credential");
  }
  const keepsCredential = input.credential === undefined && existing?.credentialCiphertext != null;
  if (credentialMode === "api_key" && typeof input.credential !== "string" && !keepsCredential) {
    throw new ModelProviderValidationError("A provider in api_key mode needs a credential");
  }

  const credentialCiphertext =
    credentialMode === "none"
      ? null
      : input.credential === undefined
        ? undefined
        : input.credential === null
          ? null
          : encryptEnvelope(input.credential, input.masterKey);

  const headersJson =
    input.headers === undefined
      ? undefined
      : input.headers === null
        ? Prisma.DbNull
        : headersSchema.parse(input.headers);
  const catalogJson =
    input.catalog === undefined
      ? undefined
      : input.catalog === null
        ? Prisma.DbNull
        : catalogSchema.parse(input.catalog);

  const provider = await db.modelProvider.upsert({
    where: { orgId_name: { orgId: input.orgId, name } },
    create: {
      orgId: input.orgId,
      name,
      label,
      protocol: input.protocol,
      baseUrl,
      credentialMode,
      ...(headersJson === undefined ? {} : { headersJson }),
      ...(credentialCiphertext === undefined ? {} : { credentialCiphertext }),
      ...(catalogJson === undefined ? {} : { catalogJson }),
    },
    update: {
      label,
      protocol: input.protocol,
      baseUrl,
      credentialMode,
      ...(headersJson === undefined ? {} : { headersJson }),
      ...(credentialCiphertext === undefined ? {} : { credentialCiphertext }),
      ...(catalogJson === undefined ? {} : { catalogJson }),
    },
  });
  log.info("Model provider saved", {
    providerName: provider.name,
    protocol: provider.protocol,
    credentialMode: provider.credentialMode,
  });
  return provider;
}

export async function listProviders(db: Database, orgId: string): Promise<ModelProviderSummary[]> {
  const providers = await db.modelProvider.findMany({
    where: { orgId },
    orderBy: { name: "asc" },
  });
  return providers.map(toProviderSummary);
}

export async function getProvider(
  db: Database,
  orgId: string,
  name: string,
): Promise<ModelProviderSummary> {
  const provider = await db.modelProvider.findUnique({
    where: { orgId_name: { orgId, name } },
  });
  if (!provider) throw new ModelProviderNotFoundError(`Model provider not found: ${name}`);
  return toProviderSummary(provider);
}

/**
 * Removes a provider. Role defaults that name it are left alone: a chain entry
 * pointing at a missing provider is skipped at resolution, which is what makes
 * the chain a fallback chain rather than a foreign key.
 */
export async function deleteProvider(db: Database, orgId: string, name: string): Promise<void> {
  const deleted = await db.modelProvider.deleteMany({ where: { orgId, name } });
  if (deleted.count === 0) {
    throw new ModelProviderNotFoundError(`Model provider not found: ${name}`);
  }
  log.info("Model provider deleted", { providerName: name });
}

export interface PutModelDefaultInput {
  orgId: string;
  role: ModelRole;
  chain: ModelChainEntry[];
}

/**
 * Assigns one role its ordered fallback chain. Every named provider must exist
 * at write time; a later deletion degrades the chain rather than breaking it.
 */
export async function putDefaults(
  db: Database,
  input: PutModelDefaultInput,
): Promise<ModelDefault> {
  const chain = chainSchema.parse(input.chain);
  if (chain.length === 0) {
    throw new ModelProviderValidationError("A role default needs at least one entry");
  }

  const names = [...new Set(chain.map((entry) => entry.providerName))];
  const known = await db.modelProvider.findMany({
    where: { orgId: input.orgId, name: { in: names } },
    select: { name: true },
  });
  const missing = names.filter((name) => !known.some((provider) => provider.name === name));
  if (missing.length > 0) {
    throw new ModelProviderValidationError(
      `Role default names no such provider: ${missing.join(", ")}`,
    );
  }

  const row = await db.modelDefault.upsert({
    where: { orgId_role: { orgId: input.orgId, role: input.role } },
    create: { orgId: input.orgId, role: input.role, chainJson: chain },
    update: { chainJson: chain },
  });
  log.info("Model role default saved", { role: input.role, chainLength: chain.length });
  return row;
}

export interface ModelRoleDefault {
  role: ModelRole;
  chain: ModelChainEntry[];
}

export async function listDefaults(db: Database, orgId: string): Promise<ModelRoleDefault[]> {
  const rows = await db.modelDefault.findMany({ where: { orgId }, orderBy: { role: "asc" } });
  return rows.map((row) => ({ role: row.role, chain: defaultChain(row) }));
}

export async function deleteDefault(db: Database, orgId: string, role: ModelRole): Promise<void> {
  const deleted = await db.modelDefault.deleteMany({ where: { orgId, role } });
  if (deleted.count === 0) {
    throw new ModelProviderNotFoundError(`No default is set for the ${role} role`);
  }
  log.info("Model role default deleted", { role });
}

/** How a caller reaches stored credentials. Absent in a deployment with none. */
export interface ResolveEndpointsOptions {
  masterKey?: string;
}

/**
 * Resolves the organization's registry into the descriptor map `@trema/models`
 * accepts. This is the one function the run path calls: everything above it is
 * administration, and everything below it is transport.
 */
export async function resolveEndpoints(
  db: Database,
  orgId: string,
  options: ResolveEndpointsOptions = {},
): Promise<ModelEndpoints> {
  const providers = await db.modelProvider.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  const endpoints: ModelEndpoints = {};
  for (const provider of providers) {
    const headers = providerHeaders(provider);
    const apiKey =
      provider.credentialCiphertext === null
        ? undefined
        : decryptEnvelope<string>(provider.credentialCiphertext, options.masterKey);
    endpoints[provider.name] = {
      protocol: descriptorProtocols[provider.protocol],
      baseUrl: provider.baseUrl,
      ...(apiKey === undefined ? {} : { apiKey }),
      ...(headers === undefined ? {} : { headers }),
    };
  }
  return endpoints;
}

/**
 * The first chain entry whose provider still exists, or undefined when the role
 * is unconfigured. Consumers decide what an unconfigured role means: turns
 * cannot run, embeddings fall back to lexical search.
 */
export async function resolveRoleModel(
  db: Database,
  orgId: string,
  role: ModelRole,
): Promise<ModelChainEntry | undefined> {
  const row = await db.modelDefault.findUnique({ where: { orgId_role: { orgId, role } } });
  if (!row) return undefined;

  const chain = defaultChain(row);
  const providers = await db.modelProvider.findMany({
    where: { orgId, name: { in: chain.map((entry) => entry.providerName) } },
    select: { name: true },
  });
  const available = new Set(providers.map((provider) => provider.name));
  const entry = chain.find((candidate) => available.has(candidate.providerName));
  if (entry === undefined && chain.length > 0) {
    log.warn("Model role default resolves to no provider", { role });
  }
  return entry;
}

export { seedModelProvidersFromEnv } from "./seed.js";
