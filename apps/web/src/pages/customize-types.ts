export type Scope = {
  id: string;
  kind: "org" | "shared" | "personal";
  name: string;
  ownerId: string | null;
};

export type Item = {
  id: string;
  scopeId: string;
  kind: "memory" | "skill" | "instruction" | "connector" | "conversation";
  title: string;
  body: unknown;
  status: "proposed" | "active" | "archived";
  disclosure: "standing" | "retrieved";
  createdById: string;
  sourceSessionId: string | null;
  confirmedById: string | null;
  updatedById: string | null;
  createdAt: string;
  updatedAt: string;
  lastUsedAt: string | null;
  version: number;
};

export type MemoryBody = {
  type: "fact" | "preference" | "rule" | "procedure";
  content: string;
};

export type InstructionBody = { content: string };

export type Sensitivity = "read" | "write" | "destructive";

export type ConnectorTool = {
  name: string;
  description?: string;
  sensitivity: Sensitivity;
};

export type ConnectorBody = {
  catalogKey: string;
  enabledTools: "all" | string[];
  syncedTools?: ConnectorTool[];
  sensitivityOverrides?: Record<string, Sensitivity>;
};

export type SkillBody = { source?: string; files?: Record<string, string> };

export type CatalogEntry = {
  key: string;
  displayName: string;
  categories: string[];
  docsUrl: string;
  authMode: string;
  transport: { type: "mcp" | "rest" };
  memberConnectable: boolean;
  toolManifest?: ConnectorTool[];
};

export type ConnectorCredential = {
  id: string;
  principalId: string;
  mode: string;
  isRevoked: boolean;
  isExpired: boolean;
  isValid: boolean;
};

export type VersionAuthor = {
  id: string;
  displayName: string;
  kind: "human" | "agent";
};

export type ItemVersion = {
  version: number;
  title: string;
  body: unknown;
  author: VersionAuthor | null;
  createdAt: string;
};

export function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function orderScopes(scopes: Scope[]): Scope[] {
  const rank = { org: 0, shared: 1, personal: 2 } as const;
  return [...scopes].sort(
    (left, right) => rank[left.kind] - rank[right.kind] || left.name.localeCompare(right.name),
  );
}

export function bodyContent(body: unknown): string {
  if (body && typeof body === "object" && "content" in body) {
    const value = (body as { content?: unknown }).content;
    if (typeof value === "string") return value;
  }
  return "";
}

export function itemContent(item: Item): string {
  if (item.kind === "memory") return (item.body as MemoryBody).content;
  if (item.kind === "instruction") return (item.body as InstructionBody).content;
  if (item.kind === "skill") return (item.body as SkillBody).files?.["SKILL.md"] ?? "";
  return "";
}
