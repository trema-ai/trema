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
  catalog: CatalogEntry[];
};

export type RemoteModels =
  | { ok: true; latencyMs: number; models: { id: string }[] }
  | { ok: false; reason: string };

export type ProbeResult =
  | { ok: true; latencyMs: number; modelCount?: number | undefined }
  | { ok: false; reason: string };

/** The roles the registry assigns, and what an unassigned one costs. */
export const roleDescriptions: {
  role: ModelRole;
  label: string;
  description: string;
  unassigned: string;
}[] = [
  {
    role: "turns",
    label: "Agent turns",
    description: "The model the agent loop runs on.",
    unassigned: "No model assigned, so runs cannot start.",
  },
  {
    role: "utility",
    label: "Utility completions",
    description: "Short completions beside a run: titles, extraction, classification.",
    unassigned: "No model assigned. Nothing calls this role yet.",
  },
  {
    role: "embed",
    label: "Embeddings",
    description: "Vectors for memory retrieval and ingestion.",
    unassigned: "No model assigned, so search falls back to lexical matching.",
  },
];

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

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
