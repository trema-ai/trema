import type { Item } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import {
  DataPlaneItemNotFoundError,
  type DataPlaneSession,
  DataPlaneToolError,
} from "#/services/dataplane/index.js";
import type { EmbeddingOptions } from "#/services/embeddings/index.js";
import {
  agentWritePolicy,
  createItem,
  type MemoryBody,
  type MemoryType,
  memoryBodySchema,
  statusForWriter,
  updateItem,
} from "#/services/items/index.js";
import { RANK_CONSTANT, searchItems } from "#/services/search/index.js";

/** How many search candidates the near-duplicate check inspects for a type match. */
export const SUPERSEDE_CANDIDATE_LIMIT = 5;

/**
 * How strong a search match has to be before a save takes over the item it
 * matched instead of adding another one.
 *
 * This is a heuristic, and it is deliberately blunt. `searchItems` fuses its
 * rankings with reciprocal rank fusion, so a score reports rank, not
 * similarity: a result at rank N of one ranking scores `1 / (RANK_CONSTANT +
 * N)`. The threshold therefore reads as "search placed this in the top
 * `SUPERSEDE_CANDIDATE_LIMIT` of at least one of its rankings" — wide enough
 * that a near-identical memory of another type ranking first cannot shadow
 * the one this save should take over.
 *
 * Three deterministic filters carry the real weight, because they are not
 * heuristics at all: the candidate sits at the session's own scope, it is a
 * memory, and it carries the same memory type. Lexical search adds a fourth —
 * its query is the whole new memory, and Postgres requires every word of it to
 * appear in the candidate.
 */
export const SUPERSEDE_SCORE_THRESHOLD = 1 / (RANK_CONSTANT + SUPERSEDE_CANDIDATE_LIMIT);

export interface SaveMemoryInput extends EmbeddingOptions {
  type: MemoryType;
  title: string;
  content: string;
}

export interface SaveMemoryResult {
  item: Item;
  /** The memory this write took over, when the near-duplicate check found one. */
  supersededId?: string;
}

export interface UpdateMemoryInput extends EmbeddingOptions {
  itemId: string;
  content: string;
}

function invalidMemory(reason: string): DataPlaneToolError {
  return new DataPlaneToolError("invalid_memory", reason);
}

function parseMemoryBody(type: MemoryType, content: string): MemoryBody {
  const parsed = memoryBodySchema.safeParse({ type, content });
  if (!parsed.success) throw invalidMemory("A memory needs a type and some content");
  return parsed.data;
}

function memoryTypeOf(item: Item): MemoryType | undefined {
  const parsed = memoryBodySchema.safeParse(item.body);
  return parsed.success ? parsed.data.type : undefined;
}

interface NearDuplicate {
  item: Item;
  /** Why the match counts as strong: the same title, or the search score. */
  reason: "title" | "score";
  score: number | null;
}

/**
 * Find the memory a new one should replace, if there is one.
 *
 * The search covers the session's own scope alone. A conflict with a wider
 * scope is not a duplicate: resolution order already settles which one the
 * agent reads, and reconciling the two is a person's call.
 */
async function findNearDuplicate(
  db: Database,
  session: DataPlaneSession,
  input: { title: string; body: MemoryBody } & EmbeddingOptions,
): Promise<NearDuplicate | undefined> {
  const sameScopeMemory = {
    orgId: session.orgId,
    scopeId: session.scopeId,
    kind: "memory",
    status: "active",
  } as const;

  // The same title at the same scope is the certain case: two memories cannot
  // be told apart by anything a search would weigh, so this is the same memory
  // written again.
  // A person may have written the same title twice through the control plane,
  // so the pick is deterministic: the most recently updated one is what the
  // scope currently treats as current, and that is the one a re-save takes over.
  const sameTitle = await db.item.findFirst({
    where: { ...sameScopeMemory, title: input.title },
    orderBy: [{ updatedAt: "desc" }, { id: "asc" }],
  });
  if (sameTitle && memoryTypeOf(sameTitle) === input.body.type) {
    return { item: sameTitle, reason: "title", score: null };
  }

  // A handful of candidates rather than one: the search cannot see memory
  // types, so a near-identical memory of another type may outrank the one this
  // save should take over. The best strong match of the right type wins.
  const candidates = await searchItems(db, {
    orgId: session.orgId,
    scopeIds: [session.scopeId],
    query: `${input.title}\n${input.body.content}`,
    kinds: ["memory"],
    limit: SUPERSEDE_CANDIDATE_LIMIT,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.embedder ? { embedder: input.embedder } : {}),
  });
  for (const candidate of candidates) {
    if (candidate.score < SUPERSEDE_SCORE_THRESHOLD) break;
    const item = await db.item.findFirst({ where: { ...sameScopeMemory, id: candidate.id } });
    // A different type is a different memory, however alike the words are: a
    // preference does not overwrite the fact it was inferred from.
    if (item && memoryTypeOf(item) === input.body.type) {
      return { item, reason: "score", score: candidate.score };
    }
  }
  return undefined;
}

/**
 * Write a memory from inside a run.
 *
 * Two rules are enforced here rather than asked of the model. The memory lands
 * at the session's own scope, never anywhere else in the chain. The memory
 * type decides its status: a fact or a preference is cheap to correct and
 * lands active, while a rule or a procedure changes future behavior silently
 * and waits for a person to activate it.
 *
 * The write policy is the agent's in every session. The data plane is the
 * agent's surface, so a personal session — which acts as the human who owns
 * the scope — still writes as the agent that is running.
 *
 * A save that restates a memory already at that scope takes it over instead of
 * adding a second one: the new title and content become the item's, and the
 * previous wording stays in the version history.
 */
export async function saveMemory(
  db: Database,
  session: DataPlaneSession,
  input: SaveMemoryInput,
): Promise<SaveMemoryResult> {
  const title = input.title.trim();
  if (!title) throw invalidMemory("A memory needs a title");
  const body = parseMemoryBody(input.type, input.content);
  const embedding = {
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.embedder ? { embedder: input.embedder } : {}),
  };

  const status = statusForWriter("agent", "memory", body);
  // Only a self-served write supersedes. A rule or a procedure lands proposed,
  // and taking over an active one would change confirmed guidance without the
  // person who confirmed it — so the near-duplicate goes to that person as a
  // second proposal instead.
  const duplicate =
    status === "active"
      ? await findNearDuplicate(db, session, { title, body, ...embedding })
      : undefined;

  const item = duplicate
    ? await updateItem(db, {
        orgId: session.orgId,
        actorPrincipalId: session.actingPrincipalId,
        itemId: duplicate.item.id,
        title,
        body,
        ...embedding,
      })
    : await createItem(db, {
        orgId: session.orgId,
        actorPrincipalId: session.actingPrincipalId,
        scopeId: session.scopeId,
        kind: "memory",
        title,
        body,
        writerKind: "agent",
        sourceSessionId: session.id,
        ...embedding,
      });

  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "dataplane.save_memory",
      subject: item.id,
      payload: {
        sessionId: session.id,
        scopeId: item.scopeId,
        kind: item.kind,
        type: body.type,
        status: item.status,
        version: item.version,
        superseded: duplicate?.item.id ?? null,
        // The reason and the score are how an operator judges the threshold
        // against real writes.
        matchReason: duplicate?.reason ?? null,
        matchScore: duplicate?.score ?? null,
      },
    },
  });
  log.info("Memory saved", {
    sessionId: session.id,
    itemId: item.id,
    type: body.type,
    status: item.status,
    version: item.version,
    superseded: duplicate !== undefined,
  });
  return { item, ...(duplicate ? { supersededId: duplicate.item.id } : {}) };
}

/**
 * Rewrite a memory the run already knows about. The item keeps its type and
 * its title; only the content changes, and the previous body stays in the
 * version history.
 */
export async function updateMemory(
  db: Database,
  session: DataPlaneSession,
  input: UpdateMemoryInput,
): Promise<Item> {
  const existing = await db.item.findFirst({
    where: {
      id: input.itemId,
      orgId: session.orgId,
      // Anything the session cannot read reports as missing, exactly as
      // get_item does. The narrower checks below only ever discuss an item the
      // caller has already seen.
      scopeId: { in: session.scopeChain },
      status: "active",
    },
  });
  if (!existing) {
    log.warn("Memory not updatable", { sessionId: session.id, itemId: input.itemId });
    throw new DataPlaneItemNotFoundError();
  }
  if (existing.scopeId !== session.scopeId) {
    throw new DataPlaneToolError(
      "wider_scope",
      "That item belongs to a wider scope. A run writes only at its own scope; a person edits the wider ones.",
    );
  }
  if (existing.kind !== "memory") {
    throw new DataPlaneToolError("not_a_memory", "This tool updates memories only");
  }

  const type = memoryTypeOf(existing);
  if (!type) throw invalidMemory("That memory has an unreadable body");
  // The write policy holds for edits too. An active rule or procedure is
  // guidance a person turned on, so a run does not rewrite it in place; it
  // saves a new memory, which lands proposed and goes back to a person.
  if (agentWritePolicy.memory[type] !== "active") {
    throw new DataPlaneToolError(
      "human_confirmation_required",
      `An active ${type} is guidance a person confirmed. Save a new ${type} with save_memory instead; a person reviews it.`,
    );
  }

  const body = parseMemoryBody(type, input.content);
  const item = await updateItem(db, {
    orgId: session.orgId,
    actorPrincipalId: session.actingPrincipalId,
    itemId: existing.id,
    body,
    ...(input.masterKey ? { masterKey: input.masterKey } : {}),
    ...(input.embedder ? { embedder: input.embedder } : {}),
  });

  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "dataplane.update_memory",
      subject: item.id,
      payload: {
        sessionId: session.id,
        scopeId: item.scopeId,
        kind: item.kind,
        type,
        status: item.status,
        version: item.version,
        previousVersion: existing.version,
      },
    },
  });
  log.info("Memory updated", {
    sessionId: session.id,
    itemId: item.id,
    type,
    version: item.version,
  });
  return item;
}
