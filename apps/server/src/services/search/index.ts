import type { ItemKind } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import type { Embedder, EmbeddingOptions } from "#/services/embeddings/index.js";
import { resolveEmbedder } from "#/services/embeddings/index.js";

const defaultLimit = 20;
const maxLimit = 50;
const rebuildBatchSize = 500;
const embedBatchSize = 32;
// How many rows each ranking contributes to the fusion.
const candidateLimit = 50;
// The damping constant from the reciprocal rank fusion paper. It flattens the
// top of each ranking so one list cannot win on its first result alone.
const rankConstant = 60;

export interface IndexableItem {
  id: string;
  orgId: string;
  kind: ItemKind;
  title: string;
  body: unknown;
}

export interface SearchItemsInput extends EmbeddingOptions {
  orgId: string;
  scopeIds: string[];
  query: string;
  limit?: number;
}

export interface ItemSearchResult {
  id: string;
  kind: ItemKind;
  title: string;
  snippet: string;
  score: number;
}

export interface BackfillEmbeddingsResult {
  embedded: number;
  failed: number;
}

function bodyContent(body: unknown): string {
  const content = (body as { content?: unknown } | null)?.content;
  return typeof content === "string" ? content : "";
}

// Only prose-bearing kinds contribute body text. Every other kind is still
// indexed, but matches on its title alone.
export function searchableText(kind: ItemKind, body: unknown): string {
  switch (kind) {
    case "memory":
      return bodyContent(body);
    case "instruction":
      return bodyContent(body);
    default:
      return "";
  }
}

// One vector covers the whole item, so the title leads the text it embeds.
export function embeddingInput(title: string, content: string): string {
  return `${title}\n${content}`;
}

function vectorLiteral(vector: number[]): string {
  if (vector.length === 0 || !vector.every((value) => Number.isFinite(value))) {
    throw new Error("An embedding must be a non-empty list of finite numbers");
  }
  return `[${vector.join(",")}]`;
}

export async function indexItem(db: Database, item: IndexableItem): Promise<void> {
  const content = searchableText(item.kind, item.body);
  // A text change invalidates the stored vector: ranking must never pair new
  // text with an old embedding. The vector clears only on a real change; the
  // embed pass that follows restores it, or backfillEmbeddings does if that
  // pass fails.
  await db.$executeRaw`
    INSERT INTO "ItemSearchDoc" ("orgId", "itemId", "title", "content")
    VALUES (${item.orgId}, ${item.id}, ${item.title}, ${content})
    ON CONFLICT ("orgId", "itemId") DO UPDATE SET
      "title" = EXCLUDED."title",
      "content" = EXCLUDED."content",
      "embedding" = CASE
        WHEN "ItemSearchDoc"."title" IS DISTINCT FROM EXCLUDED."title"
          OR "ItemSearchDoc"."content" IS DISTINCT FROM EXCLUDED."content"
        THEN NULL ELSE "ItemSearchDoc"."embedding" END,
      "embeddingModel" = CASE
        WHEN "ItemSearchDoc"."title" IS DISTINCT FROM EXCLUDED."title"
          OR "ItemSearchDoc"."content" IS DISTINCT FROM EXCLUDED."content"
        THEN NULL ELSE "ItemSearchDoc"."embeddingModel" END
  `;
}

async function writeEmbedding(
  db: Database,
  input: { orgId: string; itemId: string; vector: number[]; model: string },
): Promise<void> {
  await db.$executeRaw`
    UPDATE "ItemSearchDoc"
    SET "embedding" = ${vectorLiteral(input.vector)}::vector, "embeddingModel" = ${input.model}
    WHERE "orgId" = ${input.orgId} AND "itemId" = ${input.itemId}
  `;
}

async function embedItemSafely(
  db: Database,
  item: IndexableItem,
  options: EmbeddingOptions,
): Promise<void> {
  try {
    const embedder = await resolveEmbedder(db, item.orgId, options);
    if (!embedder) return;

    const [vector] = await embedder.embed([
      embeddingInput(item.title, searchableText(item.kind, item.body)),
    ]);
    if (!vector) return;
    await writeEmbedding(db, {
      orgId: item.orgId,
      itemId: item.id,
      vector,
      model: embedder.model,
    });
  } catch (error) {
    log.warn("Item embedding failed", { itemId: item.id, orgId: item.orgId, error });
  }
}

// The index write happens after the item transaction commits, so a failure
// here must not undo a committed write. rebuildSearchIndex and
// backfillEmbeddings repair the gap.
export async function indexItemSafely(
  db: Database,
  item: IndexableItem,
  options: EmbeddingOptions = {},
): Promise<void> {
  try {
    await indexItem(db, item);
  } catch (error) {
    // The orgId is what an operator feeds back to rebuildSearchIndex, so the
    // failure line carries it even though a request already binds it.
    log.warn("Item search index write failed", { itemId: item.id, orgId: item.orgId, error });
    return;
  }
  await embedItemSafely(db, item, options);
}

export async function rebuildSearchIndex(db: Database, orgId: string): Promise<void> {
  await db.itemSearchDoc.deleteMany({ where: { orgId } });

  let after: string | undefined;
  let indexed = 0;
  for (;;) {
    const items = await db.item.findMany({
      where: { orgId, ...(after ? { id: { gt: after } } : {}) },
      orderBy: { id: "asc" },
      take: rebuildBatchSize,
      select: { id: true, kind: true, title: true, body: true },
    });
    if (items.length === 0) break;

    // A concurrent item write can recreate a row between the delete above and
    // this insert. That row is at least as fresh as ours, so keep it rather
    // than fail the whole rebuild on its primary key.
    await db.itemSearchDoc.createMany({
      data: items.map((item) => ({
        itemId: item.id,
        orgId,
        title: item.title,
        content: searchableText(item.kind, item.body),
      })),
      skipDuplicates: true,
    });
    indexed += items.length;
    after = items[items.length - 1]!.id;
  }
  log.info("Item search index rebuilt", { orgId, itemCount: indexed });
}

/**
 * Embeds the rows that carry no vector, plus the rows whose vector came from a
 * model the organization no longer uses. Does nothing when the organization
 * has no embedding settings.
 */
export async function backfillEmbeddings(
  db: Database,
  orgId: string,
  options: EmbeddingOptions = {},
): Promise<BackfillEmbeddingsResult> {
  // Keyset pagination, not a repeated "find the stale rows" query: a row whose
  // batch fails stays stale, and re-reading from the start would never finish.
  let after = "";
  let embedded = 0;
  let failed = 0;
  for (;;) {
    // Re-resolved every batch: when the settings change mid-run, the next
    // batch embeds under the new configuration, and a deleted settings row
    // ends the run instead of writing vectors nothing will read.
    const embedder = await resolveEmbedder(db, orgId, options);
    if (!embedder) break;

    const rows = await db.$queryRaw<Array<{ itemId: string; title: string; content: string }>>`
      SELECT "itemId", "title", "content"
      FROM "ItemSearchDoc"
      WHERE "orgId" = ${orgId}
        AND ("embedding" IS NULL OR "embeddingModel" IS DISTINCT FROM ${embedder.model})
        AND "itemId" > ${after}
      ORDER BY "itemId"
      LIMIT ${embedBatchSize}
    `;
    if (rows.length === 0) break;
    after = rows[rows.length - 1]!.itemId;

    try {
      const vectors = await embedder.embed(
        rows.map((row) => embeddingInput(row.title, row.content)),
      );
      for (const [index, row] of rows.entries()) {
        const vector = vectors[index];
        if (!vector) {
          failed += 1;
          continue;
        }
        await writeEmbedding(db, { orgId, itemId: row.itemId, vector, model: embedder.model });
        embedded += 1;
      }
    } catch (error) {
      failed += rows.length;
      log.warn("Embedding backfill batch failed", { orgId, itemCount: rows.length, error });
    }
  }

  log.info("Embedding backfill finished", { orgId, embedded, failed });
  return { embedded, failed };
}

async function lexicalCandidates(
  db: Database,
  input: { orgId: string; scopeIds: string[]; query: string },
): Promise<string[]> {
  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT i."id"
    FROM "ItemSearchDoc" d
    JOIN "Item" i ON i."orgId" = d."orgId" AND i."id" = d."itemId",
         websearch_to_tsquery('english', ${input.query}) q
    WHERE d."orgId" = ${input.orgId}
      AND i."scopeId" = ANY(${input.scopeIds}::text[])
      AND i."status" = 'active'::"ItemStatus"
      AND d."tsv" @@ q
    ORDER BY ts_rank(d."tsv", q) DESC, i."id"
    LIMIT ${candidateLimit}
  `;
  return rows.map((row) => row.id);
}

async function vectorCandidates(
  db: Database,
  input: { orgId: string; scopeIds: string[]; query: string; embedder: Embedder },
): Promise<string[]> {
  const [vector] = await input.embedder.embed([input.query]);
  if (!vector) return [];

  const rows = await db.$queryRaw<Array<{ id: string }>>`
    SELECT i."id"
    FROM "ItemSearchDoc" d
    JOIN "Item" i ON i."orgId" = d."orgId" AND i."id" = d."itemId"
    WHERE d."orgId" = ${input.orgId}
      AND i."scopeId" = ANY(${input.scopeIds}::text[])
      AND i."status" = 'active'::"ItemStatus"
      AND d."embedding" IS NOT NULL
      AND d."embeddingModel" = ${input.embedder.model}
    ORDER BY d."embedding" <=> ${vectorLiteral(vector)}::vector, i."id"
    LIMIT ${candidateLimit}
  `;
  return rows.map((row) => row.id);
}

// Reciprocal rank fusion: every ranking contributes 1/(k + rank) to each id it
// lists. It needs no score calibration between the rankings, which is what
// makes a lexical rank and a cosine distance comparable at all.
function fuse(rankings: string[][]): Array<{ id: string; score: number }> {
  const scores = new Map<string, number>();
  for (const ranking of rankings) {
    for (const [index, id] of ranking.entries()) {
      scores.set(id, (scores.get(id) ?? 0) + 1 / (rankConstant + index + 1));
    }
  }
  return [...scores]
    .map(([id, score]) => ({ id, score }))
    .sort((left, right) => right.score - left.score || (left.id < right.id ? -1 : 1));
}

async function snippetsFor(
  db: Database,
  input: { orgId: string; query: string; ids: string[] },
): Promise<Map<string, { kind: ItemKind; title: string; snippet: string }>> {
  const rows = await db.$queryRaw<
    Array<{ id: string; kind: ItemKind; title: string; snippet: string }>
  >`
    SELECT i."id", i."kind", i."title",
           ts_headline('english', d."content", websearch_to_tsquery('english', ${input.query}),
                       'MaxWords=25,MinWords=8,StartSel="",StopSel=""') AS snippet
    FROM "ItemSearchDoc" d
    JOIN "Item" i ON i."orgId" = d."orgId" AND i."id" = d."itemId"
    WHERE d."orgId" = ${input.orgId}
      AND i."id" = ANY(${input.ids}::text[])
      AND i."status" = 'active'::"ItemStatus"
  `;
  return new Map(
    rows.map((row) => [row.id, { kind: row.kind, title: row.title, snippet: row.snippet }]),
  );
}

export async function searchItems(
  db: Database,
  input: SearchItemsInput,
): Promise<ItemSearchResult[]> {
  const query = input.query.trim();
  if (!query || input.scopeIds.length === 0) return [];
  const limit = Math.min(input.limit ?? defaultLimit, maxLimit);
  const filters = { orgId: input.orgId, scopeIds: input.scopeIds, query };

  const rankings = [await lexicalCandidates(db, filters)];
  try {
    const embedder = await resolveEmbedder(db, input.orgId, input);
    if (embedder) rankings.push(await vectorCandidates(db, { ...filters, embedder }));
  } catch (error) {
    // Embeddings add to lexical search, they are never a precondition for it:
    // a search that cannot reach the endpoint still answers.
    log.debug("Vector search skipped", { orgId: input.orgId, error });
  }

  const fused = fuse(rankings).slice(0, limit);
  if (fused.length === 0) return [];

  const found = await snippetsFor(db, {
    orgId: input.orgId,
    query,
    ids: fused.map(({ id }) => id),
  });
  return fused.flatMap(({ id, score }) => {
    const row = found.get(id);
    return row ? [{ id, kind: row.kind, title: row.title, snippet: row.snippet, score }] : [];
  });
}
