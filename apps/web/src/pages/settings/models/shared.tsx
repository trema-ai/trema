export type ModelRole = "turns" | "utility" | "embed";

export type ModelProtocol = "openai_compatible";

export type ModelCredentialMode = "api_key" | "none";

export type CatalogEntry = {
  id: string;
  label?: string;
  /** Whether this model is offered in the model picker. Absent means it is not. */
  offered?: boolean;
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

/** The descriptor every write repeats, because a put replaces the whole row. */
export type Descriptor = {
  name: string;
  label: string;
  protocol: ModelProtocol;
  baseUrl: string;
  credentialMode: ModelCredentialMode;
};

export function descriptorOf(provider: ModelProvider): Descriptor {
  return {
    name: provider.name,
    label: provider.label,
    protocol: provider.protocol,
    baseUrl: provider.baseUrl,
    credentialMode: provider.credentialMode,
  };
}

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

/** What a catalog refresh wrote, or why it wrote nothing. */
export type CatalogRefresh =
  | { ok: true; latencyMs: number; added: number; removed: number; provider: ModelProvider }
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

const embedRole: RoleDescription = {
  role: "embed",
  label: "Embedding model",
  description: "Vectors for memory retrieval and ingestion.",
  unassigned: "No model assigned, so search falls back to lexical matching.",
};

/** The roles the registry assigns, and what an unassigned one costs. */
export const roleDescriptions: RoleDescription[] = [turnsRole, utilityRole, embedRole];

/** What a model is asked to produce. One tab on the models screen each. */
export type Modality = {
  id: string;
  label: string;
  description: string;
  roles: RoleDescription[];
};

/**
 * The grouping the screen reads roles through. It is a reading of the role
 * enum, not a second concept: the server knows roles, and image or voice
 * arrives as a role there and an entry here.
 */
const completions: Modality = {
  id: "completions",
  label: "Completions",
  description:
    "Each role resolves down its list until a provider answers, so a second entry is a fallback.",
  roles: [turnsRole, utilityRole],
};

const embeddings: Modality = {
  id: "embeddings",
  label: "Embeddings",
  description:
    "Memory retrieval searches text and vectors together. The vectors come from this model, which resolves down its list like any other role.",
  roles: [embedRole],
};

export const modalities: Modality[] = [completions, embeddings];

/** Where the screen opens, and where a tab nobody recognizes lands. */
export const defaultModality: string = completions.id;

export function protocolLabel(protocol: string) {
  const labels: Record<string, string> = { openai_compatible: "OpenAI-compatible" };
  return labels[protocol] ?? protocol.replaceAll("_", " ");
}

export function credentialModeLabel(mode: string) {
  const labels: Record<string, string> = { api_key: "API key", none: "No credential" };
  return labels[mode] ?? mode.replaceAll("_", " ");
}

export function modelDisplayName(entry: CatalogEntry) {
  return entry.label ?? entry.id;
}

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}
