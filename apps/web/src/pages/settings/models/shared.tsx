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
};

const turnsRole: RoleDescription = {
  role: "turns",
  label: "Agent turns",
  description: "The model the agent loop runs on.",
};

const utilityRole: RoleDescription = {
  role: "utility",
  label: "Utility completions",
  description: "Short completions beside a run: titles, extraction, classification.",
};

const embedRole: RoleDescription = {
  role: "embed",
  label: "Embedding model",
  description: "Vectors for memory retrieval and ingestion.",
};

/** The roles the registry assigns. */
export const roleDescriptions: RoleDescription[] = [turnsRole, utilityRole, embedRole];

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
