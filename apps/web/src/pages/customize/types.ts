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

export type DiffSegment = { kind: "same" | "added" | "removed"; text: string };

/* Word-level LCS merge for prose diffs: one reading flow, removals shown in
   place. Tokens keep their whitespace so spacing and newlines survive. */
export function diffWords(before: string, after: string): DiffSegment[] {
  const tokenize = (text: string) => text.split(/(\s+)/).filter((token) => token.length > 0);
  const left = tokenize(before);
  const right = tokenize(after);
  const table: number[][] = Array.from({ length: left.length + 1 }, () =>
    new Array<number>(right.length + 1).fill(0),
  );
  const cell = (i: number, j: number) => table[i]?.[j] ?? 0;
  for (let i = left.length - 1; i >= 0; i -= 1) {
    const row = table[i];
    if (!row) continue;
    for (let j = right.length - 1; j >= 0; j -= 1) {
      row[j] =
        left[i] === right[j] ? cell(i + 1, j + 1) + 1 : Math.max(cell(i + 1, j), cell(i, j + 1));
    }
  }
  const segments: DiffSegment[] = [];
  const push = (kind: DiffSegment["kind"], text: string) => {
    const last = segments[segments.length - 1];
    if (last && last.kind === kind) last.text += text;
    else segments.push({ kind, text });
  };
  let i = 0;
  let j = 0;
  while (i < left.length && j < right.length) {
    const beforeToken = left[i] ?? "";
    const afterToken = right[j] ?? "";
    if (beforeToken === afterToken) {
      push("same", beforeToken);
      i += 1;
      j += 1;
    } else if (cell(i + 1, j) >= cell(i, j + 1)) {
      push("removed", beforeToken);
      i += 1;
    } else {
      push("added", afterToken);
      j += 1;
    }
  }
  while (i < left.length) {
    push("removed", left[i] ?? "");
    i += 1;
  }
  while (j < right.length) {
    push("added", right[j] ?? "");
    j += 1;
  }
  return segments;
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
