import { loadProviderCatalog, type ProviderCatalog } from "@trema/connectors";
import type { ToolDef } from "@trema/harness";
import type { z } from "zod";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  createConnectorInstallationBodySchema,
  resolveInstallationTools,
} from "#server/services/connectors/installations.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";
import {
  connectorToolDef,
  resolveConnectorToolDefs,
  type searchToolsInputSchema,
} from "#server/services/dataplane/tools.js";
import type { Embedder, EmbeddingOptions } from "#server/services/embeddings/index.js";
import { resolveEmbedder } from "#server/services/embeddings/index.js";

const textSearchConfig = "trema_multilingual";
const candidateLimit = 50;
const rankConstant = 60;
const maxSearchContentLength = 12_000;

interface ToolSearchOptions extends EmbeddingOptions {
  catalog?: ProviderCatalog;
}

interface InstallationRow {
  id: string;
  orgId: string;
  body: unknown;
  status: "proposed" | "active" | "archived";
}

function vectorLiteral(vector: number[]): string {
  if (vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
    throw new Error("An embedding must be a non-empty list of finite numbers");
  }
  return `[${vector.join(",")}]`;
}

function searchContent(providerName: string, definition: ToolDef): string {
  const schema = JSON.stringify(definition.schema);
  return [providerName, definition.key ?? "", definition.name, definition.description, schema]
    .join("\n")
    .slice(0, maxSearchContentLength);
}

function installationDocuments(
  installation: InstallationRow,
  catalog: ProviderCatalog,
): Array<{
  orgId: string;
  installationItemId: string;
  providerKey: string;
  toolName: string;
  toolKey: string;
  title: string;
  content: string;
}> {
  if (installation.status !== "active") return [];
  const parsed = createConnectorInstallationBodySchema(catalog).safeParse(installation.body);
  if (!parsed.success) return [];
  const provider = catalog.find(({ key }) => key === parsed.data.catalogKey);
  if (provider === undefined) return [];

  return resolveInstallationTools(provider, parsed.data).map((tool) => {
    const definition = connectorToolDef(provider, tool);
    return {
      orgId: installation.orgId,
      installationItemId: installation.id,
      providerKey: provider.key,
      toolName: tool.name,
      toolKey: definition.key!,
      title: definition.title,
      content: searchContent(provider.displayName, definition),
    };
  });
}

async function embedDocuments(
  db: Database,
  documents: ReturnType<typeof installationDocuments>,
  embedder: Embedder,
): Promise<void> {
  if (documents.length === 0) return;
  const vectors = await embedder.embed(
    documents.map(({ title, content }) => `${title}\n${content}`),
  );
  for (const [index, document] of documents.entries()) {
    const vector = vectors[index];
    if (vector === undefined) continue;
    await db.$executeRaw`
      UPDATE "ConnectorToolSearchDoc"
      SET "embedding" = ${vectorLiteral(vector)}::vector,
          "embeddingModel" = ${embedder.model}
      WHERE "orgId" = ${document.orgId}
        AND "installationItemId" = ${document.installationItemId}
        AND "toolName" = ${document.toolName}
        AND "title" = ${document.title}
        AND "content" = ${document.content}
    `;
  }
}

async function reconcileInstallation(
  db: Database,
  installation: InstallationRow,
  options: ToolSearchOptions,
): Promise<boolean> {
  const catalog = options.catalog ?? loadProviderCatalog();
  const documents = installationDocuments(installation, catalog);
  const current = await db.connectorToolSearchDoc.findMany({
    where: { orgId: installation.orgId, installationItemId: installation.id },
    orderBy: { toolName: "asc" },
    select: {
      providerKey: true,
      toolName: true,
      toolKey: true,
      title: true,
      content: true,
    },
  });
  const expectedComparable = documents
    .map(({ providerKey, toolName, toolKey, title, content }) => ({
      providerKey,
      toolName,
      toolKey,
      title,
      content,
    }))
    .sort((left, right) => left.toolName.localeCompare(right.toolName));
  if (JSON.stringify(current) === JSON.stringify(expectedComparable)) return false;

  await db.$transaction(async (transaction) => {
    await transaction.connectorToolSearchDoc.deleteMany({
      where: { orgId: installation.orgId, installationItemId: installation.id },
    });
    if (documents.length > 0) {
      await transaction.connectorToolSearchDoc.createMany({ data: documents });
    }
  });

  try {
    const embedder = await resolveEmbedder(db, installation.orgId, options);
    if (embedder !== undefined) await embedDocuments(db, documents, embedder);
  } catch (error) {
    log.warn("Connector tool embedding failed", {
      itemId: installation.id,
      orgId: installation.orgId,
      error,
    });
  }
  return true;
}

/** Reconcile one installation's current enabled operations into the search projection. */
export async function indexConnectorInstallationToolsSafely(
  db: Database,
  input: ToolSearchOptions & { orgId: string; installationItemId: string },
): Promise<void> {
  try {
    const installation = await db.item.findFirst({
      where: {
        orgId: input.orgId,
        id: input.installationItemId,
        kind: "connector",
      },
      select: { id: true, orgId: true, body: true, status: true },
    });
    if (installation === null) return;
    await reconcileInstallation(db, installation, input);
  } catch (error) {
    log.warn("Connector tool search index write failed", {
      itemId: input.installationItemId,
      orgId: input.orgId,
      error,
    });
  }
}

/** Rebuild every connector tool search document for one organization. */
export async function rebuildConnectorToolSearchIndex(
  db: Database,
  input: ToolSearchOptions & { orgId: string },
): Promise<{ installations: number; changed: number }> {
  const installations = await db.item.findMany({
    where: { orgId: input.orgId, kind: "connector" },
    select: { id: true, orgId: true, body: true, status: true },
  });
  let changed = 0;
  for (const installation of installations) {
    if (await reconcileInstallation(db, installation, input)) changed += 1;
  }
  log.info("Connector tool search index rebuilt", {
    orgId: input.orgId,
    installationCount: installations.length,
    changedCount: changed,
  });
  return { installations: installations.length, changed };
}

async function reconcileReachableInstallations(
  db: Database,
  session: DataPlaneSession,
  options: ToolSearchOptions,
): Promise<void> {
  const reachableKinds =
    session.scopeKind === "personal" ? (["personal"] as const) : (["org", "shared"] as const);
  const installations = await db.item.findMany({
    where: {
      orgId: session.orgId,
      scopeId: { in: session.scopeChain },
      kind: "connector",
      status: "active",
      scope: { kind: { in: [...reachableKinds] } },
    },
    select: { id: true, orgId: true, body: true, status: true },
  });
  for (const installation of installations) {
    await reconcileInstallation(db, installation, options);
  }
}

function fuse(rankings: string[][]): string[] {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [index, key] of ranking.entries()) {
      scores.set(key, (scores.get(key) ?? 0) + 1 / (rankConstant + index + 1));
    }
  }
  return [...scores]
    .sort(([leftKey, left], [rightKey, right]) => right - left || leftKey.localeCompare(rightKey))
    .map(([key]) => key);
}

async function lexicalCandidates(
  db: Database,
  orgId: string,
  toolKeys: string[],
  query: string,
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ toolKey: string }>>`
    SELECT d."toolKey"
    FROM "ConnectorToolSearchDoc" d,
         websearch_to_tsquery(${textSearchConfig}::regconfig, ${query}) q
    WHERE d."orgId" = ${orgId}
      AND d."toolKey" = ANY(${toolKeys}::text[])
      AND d."tsv" @@ q
    GROUP BY d."toolKey"
    ORDER BY max(ts_rank(d."tsv", q)) DESC, d."toolKey"
    LIMIT ${candidateLimit}
  `;
  return rows.map(({ toolKey }) => toolKey);
}

async function vectorCandidates(
  db: Database,
  orgId: string,
  toolKeys: string[],
  query: string,
  embedder: Embedder,
): Promise<string[]> {
  const [vector] = await embedder.embed([query]);
  if (vector === undefined) return [];
  const rows = await db.$queryRaw<Array<{ toolKey: string }>>`
    SELECT d."toolKey"
    FROM "ConnectorToolSearchDoc" d
    WHERE d."orgId" = ${orgId}
      AND d."toolKey" = ANY(${toolKeys}::text[])
      AND d."embedding" IS NOT NULL
      AND d."embeddingModel" = ${embedder.model}
    GROUP BY d."toolKey"
    ORDER BY min(d."embedding" <=> ${vectorLiteral(vector)}::vector), d."toolKey"
    LIMIT ${candidateLimit}
  `;
  return rows.map(({ toolKey }) => toolKey);
}

function lexicalFallback(tools: ToolDef[], query: string): ToolDef[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
  return tools
    .map((tool) => {
      const haystack =
        `${tool.key ?? ""} ${tool.title} ${tool.description} ${JSON.stringify(tool.schema)}`.toLowerCase();
      return { tool, score: terms.filter((term) => haystack.includes(term)).length };
    })
    .filter(({ score }) => score > 0)
    .sort(
      (left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name),
    )
    .map(({ tool }) => tool);
}

/** Search the current authorized connector catalog with lexical and semantic ranking. */
export async function searchConnectorTools(
  db: Database,
  session: DataPlaneSession,
  input: z.infer<typeof searchToolsInputSchema>,
  options: ToolSearchOptions = {},
): Promise<ToolDef[]> {
  const startedAt = performance.now();
  const catalog = options.catalog ?? loadProviderCatalog();
  const liveTools = await resolveConnectorToolDefs(db, session, catalog);
  const byKey = new Map(
    liveTools.flatMap((tool) => (tool.key === undefined ? [] : [[tool.key, tool] as const])),
  );
  const toolKeys = [...byKey.keys()];

  let ranked: ToolDef[] = [];
  if (toolKeys.length > 0) {
    try {
      await reconcileReachableInstallations(db, session, { ...options, catalog });
      const rankings = [await lexicalCandidates(db, session.orgId, toolKeys, input.query)];
      try {
        const embedder = await resolveEmbedder(db, session.orgId, options);
        if (embedder !== undefined) {
          rankings.push(await vectorCandidates(db, session.orgId, toolKeys, input.query, embedder));
        }
      } catch (error) {
        log.debug("Connector tool vector search skipped", { orgId: session.orgId, error });
      }
      ranked = fuse(rankings).flatMap((key) => byKey.get(key) ?? []);
    } catch (error) {
      log.warn("Connector tool index search failed", { sessionId: session.id, error });
      ranked = lexicalFallback(liveTools, input.query);
    }
  }

  const results = ranked.slice(0, input.limit ?? 5);
  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "dataplane.search_tools",
      subject: session.id,
      payload: {
        scopeChain: session.scopeChain,
        limit: input.limit ?? 5,
        candidateCount: liveTools.length,
        resultCount: results.length,
      },
    },
  });
  log.info("Connector tools searched", {
    sessionId: session.id,
    candidateCount: liveTools.length,
    resultCount: results.length,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return results;
}
