export type ModelRole = "turns" | "utility" | "embed";

export type ModelProtocol = "openai_compatible";

export type ModelCredentialMode = "api_key" | "none";

export type CatalogEntry = {
  id: string;
  label?: string;
  roles?: ModelRole[];
  contextWindow?: number;
};

export type ModelProvider = {
  name: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  headerNames: string[];
  credentialMode: ModelCredentialMode;
  hasCredential: boolean;
  catalog: CatalogEntry[];
  listQuery: Record<string, string>;
  updatedAt: string;
};

export type ChainEntry = { providerName: string; modelId: string };

export type RoleDefault = { role: ModelRole; chain: ChainEntry[] };

export type ModelProviderPreset = {
  name: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  credentialMode: ModelCredentialMode;
  icon?: string | undefined;
  listQuery?: Record<string, string> | undefined;
};

/** One model a provider listed. The hint is absent when the listing stated nothing. */
export type RemoteModel = { id: string; embedding?: boolean | undefined };

export type RemoteModels =
  | { ok: true; latencyMs: number; models: RemoteModel[] }
  | { ok: false; reason: string };

export type IndexStatus = {
  assigned: boolean;
  model?: string | undefined;
  documents: number;
  embedded: number;
  stale?: number | undefined;
  models: { model: string; count: number }[];
};

export type ProbeResult =
  | { ok: true; latencyMs: number; modelCount?: number | undefined }
  | { ok: false; reason: string };

export type RoleDescription = {
  role: ModelRole;
  label: string;
  description: string;
  unassigned: string;
};

const turnsRole: RoleDescription = {
  role: "turns",
  label: "Agent turns",
  description: "The model the agent loop runs on.",
  unassigned: "No model assigned, so runs cannot start.",
};

const utilityRole: RoleDescription = {
  role: "utility",
  label: "Utility completions",
  description: "Short completions beside a run: titles, extraction, classification.",
  unassigned: "No model assigned. Nothing calls this role yet.",
};

/**
 * The embedding role, kept out of the matrix below. It is assigned the same
 * way as the others; what differs is the cost of changing it, which is why the
 * screen gives it a section of its own.
 */
export const embedRole: RoleDescription = {
  role: "embed",
  label: "Embedding model",
  description: "Vectors for memory retrieval and ingestion.",
  unassigned: "No model assigned, so search falls back to lexical matching.",
};

/** The roles the registry assigns, and what an unassigned one costs. */
export const roleDescriptions: RoleDescription[] = [turnsRole, utilityRole, embedRole];

/** The roles the assignment matrix edits. Embeddings is assigned in its own section. */
export const matrixRoles: RoleDescription[] = [turnsRole, utilityRole];

export function protocolLabel(protocol: string) {
  const labels: Record<string, string> = { openai_compatible: "OpenAI-compatible" };
  return labels[protocol] ?? protocol.replaceAll("_", " ");
}

export function credentialModeLabel(mode: string) {
  const labels: Record<string, string> = { api_key: "API key", none: "No credential" };
  return labels[mode] ?? mode.replaceAll("_", " ");
}

export function roleLabel(role: ModelRole) {
  return roleDescriptions.find((entry) => entry.role === role)?.label ?? role;
}

export function modelDisplayName(entry: CatalogEntry) {
  return entry.label ?? entry.id;
}

/** A catalog entry with no roles is unrestricted, so it serves every role. */
export function servesRole(entry: CatalogEntry, role: ModelRole) {
  return entry.roles === undefined || entry.roles.length === 0 || entry.roles.includes(role);
}

/** The families whose names say "embedding" without the word in them. */
const embeddingFamilies = /(^|[/\-_.])(bge|gte|e5|voyage)([-_.]|$)/;

/**
 * Whether a model id reads like an embedding model. An OpenAI-compatible model
 * list carries no capability data, so this is a naming heuristic and a default
 * only: it suggests a role for a model the admin has just enabled, and never
 * overrides a role already chosen.
 */
export function looksLikeEmbeddingModel(id: string): boolean {
  const value = id.toLowerCase();
  return value.includes("embed") || embeddingFamilies.test(value);
}

/**
 * Whether a listed model produces vectors. A provider that states the
 * capability is believed; the name heuristic answers only where nothing was
 * stated, and never overrules what a provider said about its own model.
 */
export function isEmbeddingModel(id: string, hint: boolean | undefined): boolean {
  return hint ?? looksLikeEmbeddingModel(id);
}

/**
 * Whether a stored catalog entry belongs in the embedding picker. The provider
 * hint that produced it is not on this screen — reading it means a call to
 * every provider, and those run on demand only — so what survives of it is the
 * role the admin saved, with the model's name as the fallback it always was.
 */
export function offeredForEmbedding(entry: CatalogEntry): boolean {
  return entry.roles?.includes("embed") === true || looksLikeEmbeddingModel(entry.id);
}

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
