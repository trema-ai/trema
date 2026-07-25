import type { ItemKind } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";

const defaultLimit = 20;
const maxLimit = 50;
const rebuildBatchSize = 500;

export interface IndexableItem {
  id: string;
  orgId: string;
  kind: ItemKind;
  title: string;
  body: unknown;
}

export interface SearchItemsInput {
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

export async function indexItem(db: Database, item: IndexableItem): Promise<void> {
  const content = searchableText(item.kind, item.body);
  await db.itemSearchDoc.upsert({
    where: { orgId_itemId: { orgId: item.orgId, itemId: item.id } },
    create: { itemId: item.id, orgId: item.orgId, title: item.title, content },
    update: { title: item.title, content },
  });
}

// The index write happens after the item transaction commits, so a failure
// here must not undo a committed write. rebuildSearchIndex repairs the gap.
export async function indexItemSafely(db: Database, item: IndexableItem): Promise<void> {
  try {
    await indexItem(db, item);
  } catch (error) {
    // The orgId is what an operator feeds back to rebuildSearchIndex, so the
    // failure line carries it even though a request already binds it.
    log.warn("Item search index write failed", { itemId: item.id, orgId: item.orgId, error });
  }
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

    await db.itemSearchDoc.createMany({
      data: items.map((item) => ({
        itemId: item.id,
        orgId,
        title: item.title,
        content: searchableText(item.kind, item.body),
      })),
    });
    indexed += items.length;
    after = items[items.length - 1]!.id;
  }
  log.info("Item search index rebuilt", { orgId, itemCount: indexed });
}

export async function searchItems(
  db: Database,
  input: SearchItemsInput,
): Promise<ItemSearchResult[]> {
  const query = input.query.trim();
  if (!query || input.scopeIds.length === 0) return [];
  const limit = Math.min(input.limit ?? defaultLimit, maxLimit);

  const rows = await db.$queryRaw<ItemSearchResult[]>`
    SELECT i."id", i."kind", i."title",
           ts_headline('english', d."content", q, 'MaxWords=25,MinWords=8,StartSel="",StopSel=""') AS snippet,
           ts_rank(d."tsv", q) AS score
    FROM "ItemSearchDoc" d
    JOIN "Item" i ON i."orgId" = d."orgId" AND i."id" = d."itemId",
         websearch_to_tsquery('english', ${query}) q
    WHERE d."orgId" = ${input.orgId}
      AND i."scopeId" = ANY(${input.scopeIds}::text[])
      AND i."status" = 'active'::"ItemStatus"
      AND d."tsv" @@ q
    ORDER BY score DESC, i."id"
    LIMIT ${limit}
  `;

  return rows.map((row) => ({
    id: row.id,
    kind: row.kind,
    title: row.title,
    snippet: row.snippet,
    score: Number(row.score),
  }));
}
