import type { Item, ItemKind } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import type { EmbeddingOptions } from "#/services/embeddings/index.js";
import { type ItemSearchResult, searchItems } from "#/services/search/index.js";

/** How many matches `search_context` returns when the caller asks for no number. */
export const SEARCH_CONTEXT_DEFAULT_LIMIT = 8;

/** The most matches one `search_context` call may return. */
export const SEARCH_CONTEXT_MAX_LIMIT = 25;

/**
 * The session fields the data plane enforces against. The handlers take this
 * shape rather than the whole session row, so a caller cannot widen the reach
 * of a call by passing extra fields.
 */
export interface DataPlaneSession {
  id: string;
  orgId: string;
  scopeId: string;
  /** Scope IDs in resolution order, widest first. Reads never leave this list. */
  scopeChain: string[];
  actingPrincipalId: string;
}

/**
 * A refusal the caller can act on. The message goes back to the model as the
 * tool's result, so it says what to do instead; the `code` is what a harness
 * switches on.
 */
export class DataPlaneToolError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "DataPlaneToolError";
  }
}

/**
 * An item the session may not read reports exactly like an item that does not
 * exist. A distinct error would let a caller probe another scope's contents.
 */
export class DataPlaneItemNotFoundError extends DataPlaneToolError {
  constructor(message = "Item not found") {
    super("item_not_found", message);
    this.name = "DataPlaneItemNotFoundError";
  }
}

export interface SearchContextInput extends EmbeddingOptions {
  query: string;
  kinds?: ItemKind[];
  limit?: number;
}

function boundedLimit(limit: number | undefined): number {
  if (limit === undefined) return SEARCH_CONTEXT_DEFAULT_LIMIT;
  return Math.min(Math.max(Math.trunc(limit), 1), SEARCH_CONTEXT_MAX_LIMIT);
}

/**
 * Rank active items in the session's scope chain against a query. The result
 * carries excerpts, never bodies: that two-step is what keeps a fuzzy search
 * from filling the model's window.
 */
export async function searchContext(
  db: Database,
  session: DataPlaneSession,
  input: SearchContextInput,
): Promise<ItemSearchResult[]> {
  const startedAt = performance.now();
  const limit = boundedLimit(input.limit);
  const results = await searchItems(db, {
    orgId: session.orgId,
    // The scope chain is the whole read surface. There is no unscoped search.
    scopeIds: session.scopeChain,
    query: input.query,
    limit,
    ...(input.kinds ? { kinds: input.kinds } : {}),
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.embedder ? { embedder: input.embedder } : {}),
  });

  // The query text is the caller's content and stays out of both the audit
  // payload and the log line; the counts are what an operator reviews.
  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "dataplane.search_context",
      subject: session.id,
      payload: {
        scopeChain: session.scopeChain,
        kinds: input.kinds ?? null,
        limit,
        resultCount: results.length,
      },
    },
  });
  log.info("Context searched", {
    sessionId: session.id,
    limit,
    resultCount: results.length,
    durationMs: Math.round(performance.now() - startedAt),
  });
  return results;
}

/**
 * Read one item in full. The item must be active and sit in the session's
 * scope chain. Reading marks usage, which feeds decay and the "what is dead
 * weight?" view.
 */
export async function getContextItem(
  db: Database,
  session: DataPlaneSession,
  itemId: string,
  now = new Date(),
): Promise<Item> {
  const item = await db.item.findFirst({
    where: {
      id: itemId,
      orgId: session.orgId,
      scopeId: { in: session.scopeChain },
      // Proposed items await a human, and archived items left the context on
      // purpose. Neither is part of what a run may read.
      status: "active",
    },
  });
  if (!item) {
    log.warn("Context item not readable", { sessionId: session.id, itemId });
    throw new DataPlaneItemNotFoundError();
  }

  await db.$transaction(async (transaction) => {
    // A raw update, because `item.update` would also bump `updatedAt`: reading
    // an item must not read back as an edit in the version history.
    await transaction.$executeRaw`
      UPDATE "Item" SET "lastUsedAt" = ${now}
      WHERE "orgId" = ${session.orgId} AND "id" = ${item.id}
    `;
    await transaction.auditLog.create({
      data: {
        orgId: session.orgId,
        actorPrincipalId: session.actingPrincipalId,
        action: "dataplane.get_item",
        subject: item.id,
        payload: {
          sessionId: session.id,
          scopeId: item.scopeId,
          kind: item.kind,
          version: item.version,
        },
      },
    });
  });

  log.info("Context item read", {
    sessionId: session.id,
    itemId: item.id,
    kind: item.kind,
    version: item.version,
  });
  return { ...item, lastUsedAt: now };
}
