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
  anthropic: "anthropic",
  google: "google",
  openai_responses: "openai-responses",
  bedrock: "bedrock",
  vertex: "vertex",
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
  /** Whether this model is offered in the model picker. Absent means it is not. */
  offered: z.boolean().optional(),
  contextWindow: z.number().int().positive().optional(),
});

const catalogSchema = z.array(catalogEntrySchema);

/** One model a provider offers, as the provider describes it. */
export type ModelCatalogEntry = z.infer<typeof catalogEntrySchema>;

const headersSchema = z.record(z.string().trim().min(1), z.string());

const listQuerySchema = z.record(z.string().trim().min(1), z.string());

/**
 * The settings the Bedrock protocol takes. One field so far: the region every
 * SigV4 signature names. It is protocol configuration and not a secret, so it
 * is read back in full, which is exactly why it cannot ride the write-only
 * credential; and a private endpoint or a gateway leaves nothing to read it
 * off the base URL with.
 */
const bedrockSettingsSchema = z.object({ region: z.string().trim().min(1) });

/**
 * The settings the Vertex protocol takes. Vertex addresses a model under a
 * project and a location both, and neither is readable off the base URL: the
 * address there is the API surface, and a private endpoint carries neither name
 * at all. Configuration rather than secrets, so both are read back in full.
 */
const vertexSettingsSchema = z.object({
  project: z.string().trim().min(1),
  location: z.string().trim().min(1),
});

/**
 * Everything a provider row can carry as settings, across every protocol that
 * takes any. The fields are optional here and required by the protocol that
 * declares them: a row's protocol says which are filled, and a value sent for a
 * field its protocol does not name is refused rather than stored.
 */
export type ModelProviderSettings = {
  /** The region a Bedrock signature names, whatever host answers the call. */
  region?: string | undefined;
  /** The Google Cloud project a Vertex row addresses its models under. */
  project?: string | undefined;
  /** The Vertex location a row addresses its models in. */
  location?: string | undefined;
};

/** A protocol's settings, and the sentence said when a row arrives without them. */
interface ProtocolSettings {
  schema: z.ZodType<ModelProviderSettings>;
  needs: string;
}

/**
 * What each protocol accepts as settings. Every protocol has a line, so adding
 * one is a decision made rather than a default inherited, and `undefined` says
 * outright that the protocol takes none: settings sent for it are refused, not
 * stored and ignored.
 */
const protocolSettings: Record<ModelProtocol, ProtocolSettings | undefined> = {
  openai_compatible: undefined,
  anthropic: undefined,
  google: undefined,
  openai_responses: undefined,
  bedrock: { schema: bedrockSettingsSchema, needs: "a region" },
  vertex: { schema: vertexSettingsSchema, needs: "a project and a location" },
};

/**
 * The credential shape `aws_sigv4` stores: a key pair and, for temporary
 * credentials, the session token that goes with them. It is one JSON object in
 * the same encrypted column every other mode's single string uses — the column
 * holds a credential, and what a credential looks like is the mode's business.
 */
const awsCredentialSchema = z.strictObject({
  accessKeyId: z.string().trim().min(1),
  secretAccessKey: z.string().trim().min(1),
  sessionToken: z.string().trim().min(1).optional(),
});

/** The signing material a Bedrock row stores, when it stores any. */
export type AwsCredential = z.infer<typeof awsCredentialSchema>;

/**
 * Reads a stored signing credential. Neither failure repeats the value it was
 * given: a credential that travelled back out inside an error message would be
 * readable everywhere that message goes.
 */
function parseAwsCredential(value: string): AwsCredential {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ModelProviderValidationError(
      "An AWS credential is a JSON object holding accessKeyId, secretAccessKey, and an optional sessionToken",
    );
  }
  const parsed = awsCredentialSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ModelProviderValidationError(
      "An AWS credential needs a non-empty accessKeyId and secretAccessKey, and nothing else beyond an optional sessionToken",
    );
  }
  return parsed.data;
}

/**
 * The credential shape `gcp_adc` stores, and the shape an admin arrives with:
 * a downloaded service-account key file. Only two of its fields mint a token,
 * so only those two are named — and the schema is deliberately not strict, so
 * the file can be pasted whole rather than hand-edited down to a pair. What the
 * rest of it carries (a key id, a project, four fixed URLs) is stripped by
 * `parseGcpCredential` rather than stored: a credential column holds what will
 * be spent and no more.
 */
const gcpCredentialSchema = z.object({
  client_email: z.string().trim().min(1),
  private_key: z.string().trim().min(1),
});

/**
 * The service-account material a Vertex row stores, when it stores any. Kept in
 * the key file's own field names rather than renamed: one parser then serves
 * both the write and the read, and what is stored stays recognizable as a
 * shrunken copy of what was pasted.
 */
export type GcpCredential = z.infer<typeof gcpCredentialSchema>;

/**
 * Reads a stored service account, from the key file it was pasted as. Neither
 * failure repeats the value it was given: a credential that travelled back out
 * inside an error message would be readable everywhere that message goes.
 */
function parseGcpCredential(value: string): GcpCredential {
  let decoded: unknown;
  try {
    decoded = JSON.parse(value);
  } catch {
    throw new ModelProviderValidationError(
      "A Google credential is a service-account key file, as the JSON it was downloaded as",
    );
  }
  const parsed = gcpCredentialSchema.safeParse(decoded);
  if (!parsed.success) {
    throw new ModelProviderValidationError(
      "A Google credential needs the client_email and private_key its key file carries",
    );
  }
  return { client_email: parsed.data.client_email, private_key: parsed.data.private_key };
}

/**
 * The modes whose stored credential is a JSON object rather than one string.
 * The shape belongs to the mode that wrote it, so a kept credential cannot
 * cross into or out of one of these: what wrote it is what can read it.
 */
const structuredCredentialModes = new Set<ModelCredentialMode>(["aws_sigv4", "gcp_adc"]);

/**
 * What an HTTP header field cannot carry, in either half. Scanned rather than
 * matched, because a control character inside a pattern is its own lint error.
 */
function hasControlCharacter(value: string): boolean {
  for (const character of value) {
    const code = character.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/** What RFC 9110 allows in a field name. Anything else is not a header name. */
const headerNamePattern = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

export class ModelProviderValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderValidationError";
  }
}

/** The name a create asked for is taken. Raised by the unique index, not by a prior read. */
export class ModelProviderAlreadyExistsError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderAlreadyExistsError";
  }
}

/** Nothing in the registry answers to what the caller named — a provider or a role. */
export class ModelProviderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelProviderNotFoundError";
  }
}

/**
 * Refuses a value that cannot become a header. The transport would reject it
 * anyway, but it reports the offending value in the error it throws — so a
 * credential with a stray newline in it would travel back out through whatever
 * surfaces that error. Refusing at write time keeps that value out of every
 * later message.
 */
function assertHeaderValue(value: string, label: string): void {
  if (hasControlCharacter(value)) {
    throw new ModelProviderValidationError(`${label} cannot contain control characters`);
  }
}

function normalizeHeaders(headers: Record<string, string>): Record<string, string> {
  const parsed = headersSchema.parse(headers);
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const field = name.trim();
    if (!headerNamePattern.test(field)) {
      throw new ModelProviderValidationError(`Header name is not a valid HTTP header: ${field}`);
    }
    const trimmed = value.trim();
    assertHeaderValue(trimmed, `The value of the ${field} header`);
    normalized[field] = trimmed;
  }
  return normalized;
}

/**
 * Checks the query a listing call carries. It is read back in full, the way the
 * base URL is, so the same rule holds: a control character cannot travel in a
 * URL, and a secret does not belong here — the credential field and the header
 * map are the write-only ones.
 */
function normalizeListQuery(listQuery: Record<string, string>): Record<string, string> {
  const parsed = listQuerySchema.parse(listQuery);
  const normalized: Record<string, string> = {};
  for (const [name, value] of Object.entries(parsed)) {
    const field = name.trim();
    if (hasControlCharacter(field) || hasControlCharacter(value)) {
      throw new ModelProviderValidationError(
        `The ${field} listing parameter cannot contain control characters`,
      );
    }
    normalized[field] = value;
  }
  return normalized;
}

/**
 * Checks the settings a row carries against the shape its protocol declares.
 * The rule is a lookup, not a judgement: a protocol that declares no shape
 * refuses settings outright rather than storing something no code will read.
 */
function normalizeSettings(
  protocol: ModelProtocol,
  settings: ModelProviderSettings,
): ModelProviderSettings {
  const declared = protocolSettings[protocol];
  if (declared === undefined) {
    throw new ModelProviderValidationError(`The ${protocol} protocol takes no settings`);
  }
  const parsed = declared.schema.safeParse(settings);
  if (!parsed.success) {
    throw new ModelProviderValidationError(
      `The ${protocol} protocol needs ${declared.needs}, as non-empty strings`,
    );
  }
  const normalized: ModelProviderSettings = {};
  for (const [field, value] of Object.entries(parsed.data)) {
    const trimmed = String(value).trim();
    // Every one of these is read back in full and spent on a request line, so
    // the same rule the base URL keeps applies: a control character cannot
    // travel in either.
    if (hasControlCharacter(trimmed)) {
      throw new ModelProviderValidationError(
        `The ${field} setting cannot contain control characters`,
      );
    }
    normalized[field as keyof ModelProviderSettings] = trimmed;
  }
  return normalized;
}

export function normalizeCatalog(catalog: ModelCatalogEntry[]): ModelCatalogEntry[] {
  const parsed = catalogSchema.parse(catalog);
  const seen = new Set<string>();
  for (const entry of parsed) {
    // Two rows for one id makes a role assignment ambiguous, and the screen
    // cannot tell the admin which of the two it picked.
    if (seen.has(entry.id)) {
      throw new ModelProviderValidationError(`Provider catalog lists ${entry.id} twice`);
    }
    seen.add(entry.id);
  }
  return parsed;
}

/**
 * The stored form every caller appends a path to (`${baseUrl}/models`). String
 * concatenation is the whole reason this is strict: a query or fragment would
 * land in the middle of the request path, and a trailing slash would double up.
 * Normalizing once at write time keeps the read paths plain.
 */
function normalizeBaseUrl(baseUrl: string): string {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl.trim());
  } catch {
    throw new ModelProviderValidationError("Provider base URL must be an absolute URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new ModelProviderValidationError("Provider base URL must be an http or https URL");
  }
  if (parsed.search !== "" || parsed.hash !== "") {
    throw new ModelProviderValidationError("The base URL cannot carry a query or fragment");
  }
  // The base URL is read back in full, so a secret inside it would be readable;
  // headers and the credential field get write-only treatment instead.
  if (parsed.username !== "" || parsed.password !== "") {
    throw new ModelProviderValidationError(
      "The base URL cannot carry credentials. Store a token as the credential or a header instead",
    );
  }
  parsed.pathname = parsed.pathname.replace(/\/+$/, "");
  return parsed.toString().replace(/\/+$/, "");
}

/**
 * The registry's write surface, satisfied by both the client and a transaction.
 * Seeding needs several writes to land or fail together; nothing here reaches
 * for a client-only method.
 */
export type RegistryClient = Pick<Database, "modelProvider" | "modelDefault">;

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

export function providerListQuery(provider: ModelProvider): Record<string, string> {
  if (provider.listQueryJson === null) return {};
  return parseJsonColumn(listQuerySchema, provider.listQueryJson, "provider listing query");
}

/**
 * The row's protocol settings, or undefined where it stores none. Read through
 * the schema its protocol declares, so a row hand-edited into a shape the
 * protocol does not take is malformed rather than half-usable.
 */
export function providerSettings(provider: ModelProvider): ModelProviderSettings | undefined {
  if (provider.settingsJson === null) return undefined;
  const declared = protocolSettings[provider.protocol];
  if (declared === undefined) {
    throw new ModelProviderValidationError("Stored provider settings are malformed");
  }
  return parseJsonColumn(declared.schema, provider.settingsJson, "provider settings");
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
  /**
   * Which headers are set, not what they hold. Nothing stops an admin putting a
   * bearer token in a custom header, so header values get the credential's
   * treatment: written once, reported as presence thereafter.
   */
  headerNames: string[];
  credentialMode: ModelCredentialMode;
  hasCredential: boolean;
  catalog: ModelCatalogEntry[];
  /**
   * The query the provider's own model listing is fetched with. Unlike the
   * header map this is read back: it is a filter a preset seeded, not a place
   * for a secret.
   */
  listQuery: Record<string, string>;
  /**
   * The protocol configuration this row carries, where its protocol takes any.
   * Read back like the base URL and for the same reason: it is configuration an
   * admin has to be able to see and correct, not a secret.
   */
  settings?: ModelProviderSettings;
  updatedAt: Date;
}

export function toProviderSummary(provider: ModelProvider): ModelProviderSummary {
  const settings = providerSettings(provider);
  return {
    name: provider.name,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    headerNames: Object.keys(providerHeaders(provider) ?? {}).sort(),
    credentialMode: provider.credentialMode,
    hasCredential: provider.credentialCiphertext !== null,
    catalog: providerCatalog(provider),
    listQuery: providerListQuery(provider),
    ...(settings === undefined ? {} : { settings }),
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
  /** Omit to keep the stored listing query; `null` clears it. */
  listQuery?: Record<string, string> | null;
  /** Omit to keep the stored settings; `null` clears them. */
  settings?: ModelProviderSettings | null;
  masterKey?: string;
  /**
   * What a name already in the registry means. `reject` refuses it through the
   * unique index rather than the read above, so two admins creating the same
   * provider at once cannot both win.
   */
  onExisting?: "replace" | "reject";
}

/** The insert that lets the unique index answer, rather than the read before it. */
async function createRow(
  db: RegistryClient,
  data: Prisma.ModelProviderUncheckedCreateInput,
): Promise<ModelProvider> {
  try {
    return await db.modelProvider.create({ data });
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      throw new ModelProviderAlreadyExistsError(`A provider named ${data.name} already exists`);
    }
    throw error;
  }
}

/**
 * Creates or replaces one provider. The credential is write-only: an omitted
 * value keeps whatever is stored, so an admin can edit a base URL without
 * re-entering a key.
 */
export async function putProvider(
  db: RegistryClient,
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
  // A signing mode takes a key pair or nothing at all: nothing at all is the
  // ambient role the spec names, a supported configuration and not a hole. What
  // it will not take is a credential shaped like some other mode's.
  if (credentialMode === "aws_sigv4" && typeof input.credential === "string") {
    parseAwsCredential(input.credential);
  }
  // The Google mode also takes a JSON object or nothing at all, and what it is
  // given is the key file an admin downloaded, formatting and spare fields and
  // all. It is stored as the pair a token exchange spends, so the value written
  // is the parse rather than the paste.
  const credential =
    credentialMode === "gcp_adc" && typeof input.credential === "string"
      ? JSON.stringify(parseGcpCredential(input.credential))
      : input.credential;
  // The stored credential's shape belongs to the mode that wrote it, so a row
  // moving into or out of a structured one cannot keep a credential it did not
  // write. Every other mode stores a plain string, which is why only these
  // pairings have to ask.
  if (
    keepsCredential &&
    existing !== null &&
    credentialMode !== existing.credentialMode &&
    (structuredCredentialModes.has(credentialMode) ||
      structuredCredentialModes.has(existing.credentialMode))
  ) {
    throw new ModelProviderValidationError(
      "Switching a provider between credential shapes means entering its credential again",
    );
  }
  if (typeof credential === "string") {
    assertHeaderValue(credential, "The provider credential");
  }

  const credentialCiphertext =
    credentialMode === "none"
      ? null
      : credential === undefined
        ? undefined
        : credential === null
          ? null
          : encryptEnvelope(credential, input.masterKey);

  const headersJson =
    input.headers === undefined
      ? undefined
      : input.headers === null
        ? Prisma.DbNull
        : normalizeHeaders(input.headers);
  const catalogJson =
    input.catalog === undefined
      ? undefined
      : input.catalog === null
        ? Prisma.DbNull
        : normalizeCatalog(input.catalog);
  const listQueryJson =
    input.listQuery === undefined
      ? undefined
      : input.listQuery === null
        ? Prisma.DbNull
        : normalizeListQuery(input.listQuery);
  const settingsJson =
    input.settings === undefined
      ? undefined
      : input.settings === null
        ? Prisma.DbNull
        : normalizeSettings(input.protocol, input.settings);
  // A protocol that declares a settings shape needs it filled, and the row it
  // is stored on carries the protocol, so a row switched to one after the fact
  // is caught here rather than at the first call it cannot sign. What is
  // already stored counts: an edit to the label does not restate the region.
  const declaredSettings = protocolSettings[input.protocol];
  if (
    declaredSettings !== undefined &&
    settingsJson === undefined &&
    (existing === null ||
      existing.protocol !== input.protocol ||
      existing.settingsJson === null ||
      existing.settingsJson === undefined)
  ) {
    throw new ModelProviderValidationError(
      `The ${input.protocol} protocol needs ${declaredSettings.needs}`,
    );
  }
  // Settings the new protocol cannot read are dropped rather than left to fail
  // the next read: a row moved off a protocol keeps nothing that belonged to it.
  const clearedSettings =
    settingsJson === undefined &&
    declaredSettings === undefined &&
    existing !== null &&
    existing.settingsJson !== null
      ? Prisma.DbNull
      : undefined;

  const written = {
    label,
    protocol: input.protocol,
    baseUrl,
    credentialMode,
    ...(headersJson === undefined ? {} : { headersJson }),
    ...(credentialCiphertext === undefined ? {} : { credentialCiphertext }),
    ...(catalogJson === undefined ? {} : { catalogJson }),
    ...(listQueryJson === undefined ? {} : { listQueryJson }),
    ...(settingsJson === undefined ? {} : { settingsJson }),
    ...(clearedSettings === undefined ? {} : { settingsJson: clearedSettings }),
  };

  const provider =
    input.onExisting === "reject"
      ? await createRow(db, { orgId: input.orgId, name, ...written })
      : await db.modelProvider.upsert({
          where: { orgId_name: { orgId: input.orgId, name } },
          create: { orgId: input.orgId, name, ...written },
          update: written,
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
  db: RegistryClient,
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
 * One row as transport sees it. The credential is decrypted here and nowhere
 * else: everything above this line handles status, everything below handles
 * headers.
 */
function toEndpoint(provider: ModelProvider, options: ResolveEndpointsOptions): ModelEndpoint {
  const headers = providerHeaders(provider);
  const stored =
    provider.credentialCiphertext === null
      ? undefined
      : decryptEnvelope<string>(provider.credentialCiphertext, options.masterKey);
  const protocol = descriptorProtocols[provider.protocol];

  const settings = providerSettings(provider);

  if (protocol === "bedrock") {
    if (settings?.region === undefined) {
      // Unusable rather than half-configured: nothing can sign for a region
      // nobody stated, and `resolveEndpoints` drops the row with a warning.
      throw new ModelProviderValidationError("A Bedrock provider needs a stored region");
    }
    // No stored credential is a supported state, not a missing one: the
    // resolver then lets the SDK sign with whatever role the worker runs under.
    const credential = stored === undefined ? undefined : parseAwsCredential(stored);
    return {
      protocol,
      baseUrl: provider.baseUrl,
      region: settings.region,
      ...(credential === undefined
        ? {}
        : {
            accessKeyId: credential.accessKeyId,
            secretAccessKey: credential.secretAccessKey,
            ...(credential.sessionToken === undefined
              ? {}
              : { sessionToken: credential.sessionToken }),
          }),
      ...(headers === undefined ? {} : { headers }),
    };
  }

  if (protocol === "vertex") {
    if (settings?.project === undefined || settings.location === undefined) {
      // Unusable rather than half-configured, for the same reason as above:
      // there is no model to address without both, and the address alone
      // carries neither.
      throw new ModelProviderValidationError(
        "A Vertex provider needs a stored project and location",
      );
    }
    // No stored credential is a supported state, not a missing one: the
    // resolver then leaves the provider its own credential chain, which reads
    // whatever the worker itself can reach.
    const credential = stored === undefined ? undefined : parseGcpCredential(stored);
    return {
      protocol,
      baseUrl: provider.baseUrl,
      project: settings.project,
      location: settings.location,
      ...(credential === undefined
        ? {}
        : {
            serviceAccount: {
              clientEmail: credential.client_email,
              privateKey: credential.private_key,
            },
          }),
      ...(headers === undefined ? {} : { headers }),
    };
  }

  return {
    protocol,
    baseUrl: provider.baseUrl,
    ...(stored === undefined ? {} : { apiKey: stored }),
    ...(headers === undefined ? {} : { headers }),
  };
}

/** Everything one direct call to a provider needs, credential included. */
export interface ProviderTransport {
  endpoint: ModelEndpoint;
  /** The query its own model listing is fetched with. Empty for most providers. */
  listQuery: Record<string, string>;
}

/**
 * One provider as the code that calls it sees it. Callers keep it in memory
 * only.
 */
export async function resolveProviderTransport(
  db: Database,
  orgId: string,
  name: string,
  options: ResolveEndpointsOptions = {},
): Promise<ProviderTransport> {
  const provider = await db.modelProvider.findUnique({ where: { orgId_name: { orgId, name } } });
  if (!provider) throw new ModelProviderNotFoundError(`Model provider not found: ${name}`);
  return { endpoint: toEndpoint(provider, options), listQuery: providerListQuery(provider) };
}

/**
 * Resolves the organization's registry into the descriptor map `@trema/models`
 * accepts. This is the one function the run path calls: everything above it is
 * administration, and everything below it is transport.
 *
 * A provider whose stored state cannot be read — an undecryptable credential
 * after a key rotation, a hand-edited JSON column — is dropped with a warning
 * rather than failing the call. One unusable row must not take down the
 * providers beside it, which is what lets a role's fallback chain work.
 */
export async function resolveEndpoints(
  db: Database,
  orgId: string,
  options: ResolveEndpointsOptions = {},
): Promise<ModelEndpoints> {
  const providers = await db.modelProvider.findMany({ where: { orgId }, orderBy: { name: "asc" } });
  const endpoints: ModelEndpoints = {};
  for (const provider of providers) {
    try {
      endpoints[provider.name] = toEndpoint(provider, options);
    } catch (error) {
      log.warn("Model provider unusable", { providerName: provider.name, error });
    }
  }
  return endpoints;
}

/** The role's ordered chain as stored, or an empty chain when the role has no row. */
export async function resolveRoleChain(
  db: Database,
  orgId: string,
  role: ModelRole,
): Promise<ModelChainEntry[]> {
  const row = await db.modelDefault.findUnique({ where: { orgId_role: { orgId, role } } });
  return row ? defaultChain(row) : [];
}

/**
 * The first chain entry whose provider still exists, or undefined when the role
 * is unconfigured. Consumers decide what an unconfigured role means: turns
 * cannot run, embeddings fall back to lexical search.
 *
 * Callers that are about to reach the endpoint should walk the chain against a
 * resolved `ModelEndpoints` instead, so a provider that exists but cannot be
 * read falls through to the next entry.
 */
export async function resolveRoleModel(
  db: Database,
  orgId: string,
  role: ModelRole,
): Promise<ModelChainEntry | undefined> {
  const chain = await resolveRoleChain(db, orgId, role);
  if (chain.length === 0) return undefined;

  const providers = await db.modelProvider.findMany({
    where: { orgId, name: { in: chain.map((entry) => entry.providerName) } },
    select: { name: true },
  });
  const available = new Set(providers.map((provider) => provider.name));
  const entry = chain.find((candidate) => available.has(candidate.providerName));
  if (entry === undefined) {
    log.warn("Model role default resolves to no provider", { role });
  }
  return entry;
}

export { seedModelProvidersFromEnv } from "./seed.js";
