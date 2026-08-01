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

export type ConnectorTool = {
  name: string;
  description?: string;
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean };
};

export type ConnectorBody = {
  catalogKey: string;
  connectionId: string;
  access:
    | { kind: "scope" }
    | { kind: "minimum_role"; role: "owner" | "admin" | "member" | "viewer" };
  enabledTools: "all" | string[];
  syncedTools?: ConnectorTool[];
};

const connectorRoles = new Set(["owner", "admin", "member", "viewer"]);

/**
 * Normalize connector bodies read through the generic item API. That API
 * returns durable JSON verbatim, including installations created before the
 * access field existed, so a type assertion alone cannot make the field real.
 */
export function normalizeConnectorBody(value: unknown): ConnectorBody | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const body = value as Record<string, unknown>;
  if (
    typeof body.catalogKey !== "string" ||
    body.catalogKey.trim() === "" ||
    typeof body.connectionId !== "string" ||
    body.connectionId.trim() === ""
  ) {
    return undefined;
  }

  const enabledTools =
    body.enabledTools === "all"
      ? "all"
      : Array.isArray(body.enabledTools) &&
          body.enabledTools.every((tool): tool is string => typeof tool === "string")
        ? body.enabledTools
        : undefined;
  if (enabledTools === undefined) return undefined;

  let syncedTools: ConnectorTool[] | undefined;
  if (body.syncedTools !== undefined) {
    if (
      !Array.isArray(body.syncedTools) ||
      !body.syncedTools.every(
        (tool) =>
          typeof tool === "object" &&
          tool !== null &&
          !Array.isArray(tool) &&
          typeof (tool as Record<string, unknown>).name === "string" &&
          ((tool as Record<string, unknown>).name as string).trim() !== "",
      )
    ) {
      return undefined;
    }
    // The member card only needs tool names to determine whether an MCP
    // installation is usable; richer schemas remain server-owned.
    syncedTools = body.syncedTools.map((tool) => ({
      name: (tool as Record<string, unknown>).name as string,
    }));
  }

  let access: ConnectorBody["access"];
  if (body.access === undefined) {
    access = { kind: "scope" };
  } else if (
    typeof body.access === "object" &&
    body.access !== null &&
    !Array.isArray(body.access) &&
    (body.access as Record<string, unknown>).kind === "scope"
  ) {
    access = { kind: "scope" };
  } else if (
    typeof body.access === "object" &&
    body.access !== null &&
    !Array.isArray(body.access) &&
    (body.access as Record<string, unknown>).kind === "minimum_role" &&
    typeof (body.access as Record<string, unknown>).role === "string" &&
    connectorRoles.has((body.access as Record<string, unknown>).role as string)
  ) {
    access = {
      kind: "minimum_role",
      role: (body.access as { role: "owner" | "admin" | "member" | "viewer" }).role,
    };
  } else {
    return undefined;
  }

  return {
    catalogKey: body.catalogKey,
    connectionId: body.connectionId,
    access,
    enabledTools,
    ...(syncedTools === undefined ? {} : { syncedTools }),
  };
}

export type SkillBody = { source?: string; files?: Record<string, string> };

export type CatalogEntry = {
  key: string;
  displayName: string;
  categories: string[];
  docsUrl: string;
  authMode: string;
  transport: { type: "mcp" | "rest" };
  supportsPersonalOAuth: boolean;
  toolManifest?: ConnectorTool[];
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
