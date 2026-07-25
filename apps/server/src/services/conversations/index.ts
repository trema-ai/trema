import type { Conversation, Message, Prisma } from "#/generated/prisma/client.js";
import type { Database } from "#/lib/db/index.js";
import { log } from "#/lib/logger/index.js";
import { SessionClosedError, SessionExpiredError } from "#/services/sessions/index.js";

/** How many messages one capture call may report. */
export const MESSAGE_BATCH_LIMIT = 200;

export class ConversationValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConversationValidationError";
  }
}

/**
 * One person seen in a thread. A linked person carries a principal; anyone
 * else carries the raw surface id, so the thread still names who spoke.
 */
export interface ConversationParticipant {
  principalId: string | null;
  externalRef: string | null;
}

/** What a reported message asks for: `delete` retracts, `upsert` lands or edits. */
export type MessageOperation = "upsert" | "delete";

export interface MessageAuthorInput {
  principalId?: string;
  externalRef?: string;
}

export interface CapturedMessageInput {
  surfaceMessageRef: string;
  operation?: MessageOperation;
  author?: MessageAuthorInput;
  sentAt?: Date;
  text?: string;
}

/** What became of one reported message. */
export type MessageOutcome = "created" | "updated" | "unchanged" | "deleted" | "not_found";

export interface CapturedMessageResult {
  surfaceMessageRef: string;
  outcome: MessageOutcome;
  /** The message's place in the thread, or null when nothing was there to act on. */
  seq: number | null;
}

export interface CaptureMessagesResult {
  conversation: Conversation;
  results: CapturedMessageResult[];
  created: number;
  updated: number;
  unchanged: number;
  deleted: number;
  notFound: number;
  /** How many messages the conversation holds after the batch. */
  messageCount: number;
}

/**
 * The session fields a capture reads. Taking this shape rather than the whole
 * row keeps the thread's identity and its scope where the session protocol put
 * them.
 */
export interface CaptureSession {
  id: string;
  orgId: string;
  scopeId: string;
  surface: string;
  locationRef: string;
  threadRef: string | null;
  actingPrincipalId: string;
}

/**
 * The thread a session belongs to.
 *
 * A surface without threads — a direct message, a command-line run — reports
 * none, and the empty string stands in for it. A nullable key column would let
 * Postgres treat every such conversation as distinct, because a unique index
 * counts nulls as different values; and no real thread can collide with the
 * sentinel, because the session protocol refuses an empty `threadRef`.
 */
export function conversationThreadRef(session: { threadRef: string | null }): string {
  return session.threadRef ?? "";
}

interface NormalizedMessage {
  surfaceMessageRef: string;
  operation: MessageOperation;
  principalId: string | null;
  externalRef: string | null;
  sentAt: Date;
  text: string;
}

function normalize(input: CapturedMessageInput): NormalizedMessage {
  const surfaceMessageRef = input.surfaceMessageRef.trim();
  if (!surfaceMessageRef) {
    throw new ConversationValidationError("A message needs a surfaceMessageRef");
  }
  const operation = input.operation ?? "upsert";
  if (operation === "delete") {
    return {
      surfaceMessageRef,
      operation,
      principalId: null,
      externalRef: null,
      sentAt: new Date(0),
      text: "",
    };
  }

  const text = input.text ?? "";
  if (!text.trim()) {
    throw new ConversationValidationError(`Message ${surfaceMessageRef} has no text`);
  }
  if (!input.sentAt || Number.isNaN(input.sentAt.getTime())) {
    throw new ConversationValidationError(`Message ${surfaceMessageRef} needs a valid sentAt`);
  }
  const principalId = input.author?.principalId?.trim() || null;
  const externalRef = input.author?.externalRef?.trim() || null;
  if (!principalId && !externalRef) {
    throw new ConversationValidationError(
      `Message ${surfaceMessageRef} needs an author principalId or externalRef`,
    );
  }
  return { surfaceMessageRef, operation, principalId, externalRef, sentAt: input.sentAt, text };
}

// A reported principal must be one of this organization's. The foreign key
// would refuse an outsider anyway; checking first turns that into a message
// the harness can read.
async function assertAuthorsExist(
  db: Database,
  orgId: string,
  messages: NormalizedMessage[],
): Promise<void> {
  const ids = [...new Set(messages.flatMap((message) => message.principalId ?? []))];
  if (ids.length === 0) return;
  const found = await db.principal.findMany({
    where: { orgId, id: { in: ids } },
    select: { id: true },
  });
  if (found.length !== ids.length) {
    throw new ConversationValidationError("Message author principal not found");
  }
}

/**
 * Fill in the principal behind a raw surface id, where the organization knows
 * it. The link is the same deterministic lookup the session protocol uses for
 * a requester; the raw id is kept either way, so an unlinked author is still
 * named.
 */
async function resolveAuthors(
  db: Database,
  orgId: string,
  surface: string,
  messages: NormalizedMessage[],
): Promise<void> {
  const refs = [
    ...new Set(
      messages.flatMap((message) =>
        message.principalId === null && message.externalRef !== null ? message.externalRef : [],
      ),
    ),
  ];
  if (refs.length === 0) return;
  const links = await db.identityLink.findMany({
    where: { orgId, surface, externalUserId: { in: refs } },
    select: { externalUserId: true, principal: { select: { id: true, kind: true } } },
  });
  const byRef = new Map(
    links.flatMap((link) =>
      link.principal.kind === "human" ? [[link.externalUserId, link.principal.id] as const] : [],
    ),
  );
  for (const message of messages) {
    if (message.principalId === null && message.externalRef !== null) {
      message.principalId = byRef.get(message.externalRef) ?? null;
    }
  }
}

function participantKey(participant: ConversationParticipant): string {
  return participant.principalId ? `p:${participant.principalId}` : `x:${participant.externalRef}`;
}

function readParticipants(value: Prisma.JsonValue): ConversationParticipant[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return [];
    const record = entry as Record<string, unknown>;
    const principalId = typeof record.principalId === "string" ? record.principalId : null;
    const externalRef = typeof record.externalRef === "string" ? record.externalRef : null;
    return principalId || externalRef ? [{ principalId, externalRef }] : [];
  });
}

// Merged in report order, so the list reads as the order people first appeared.
function mergeParticipants(
  stored: ConversationParticipant[],
  seen: ConversationParticipant[],
): ConversationParticipant[] {
  const merged = new Map(stored.map((participant) => [participantKey(participant), participant]));
  for (const participant of seen) {
    // A raw id that has since been linked upgrades in place, so one person is
    // never listed twice: the bare entry their earlier messages recorded gives
    // way to the linked one.
    if (participant.principalId && participant.externalRef) {
      merged.delete(`x:${participant.externalRef}`);
    }
    const key = participantKey(participant);
    const existing = merged.get(key);
    if (!existing) merged.set(key, participant);
    else if (!existing.externalRef && participant.externalRef) merged.set(key, participant);
  }
  return [...merged.values()];
}

/**
 * Find the conversation for a session's thread, or start it.
 *
 * The create runs outside the capture transaction on purpose: two harnesses
 * reporting the first messages of one thread race here, and the loser's unique
 * violation has to be answered with a read rather than a rolled-back batch.
 */
async function ensureConversation(
  db: Database,
  session: CaptureSession,
  threadRef: string,
  span: { earliest: Date; latest: Date },
  hasUpserts: boolean,
): Promise<{ conversation: Conversation; started: boolean }> {
  const identity = {
    orgId: session.orgId,
    surface: session.surface,
    locationRef: session.locationRef,
    threadRef,
  };
  const existing = await db.conversation.findUnique({
    where: { orgId_surface_locationRef_threadRef: identity },
  });
  if (existing) return { conversation: existing, started: false };

  // A batch of nothing but deletions retracts messages that were never
  // reported. Starting an empty conversation for it would record a thread
  // that never said anything.
  if (!hasUpserts) {
    throw new ConversationValidationError("This thread has no captured conversation");
  }

  try {
    const conversation = await db.conversation.create({
      data: {
        ...identity,
        scopeId: session.scopeId,
        // A thread's clock is the messages', not the capture's: a batch
        // reported hours late still dates from when it was said.
        startedAt: span.earliest,
        lastActivityAt: span.latest,
      },
    });
    return { conversation, started: true };
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const conversation = await db.conversation.findUniqueOrThrow({
      where: { orgId_surface_locationRef_threadRef: identity },
    });
    return { conversation, started: false };
  }
}

function isUniqueViolation(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2002";
}

function isRecordNotFound(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "P2025";
}

function sameMessage(stored: Message, reported: NormalizedMessage): boolean {
  return (
    stored.text === reported.text &&
    stored.authorPrincipalId === reported.principalId &&
    stored.authorExternalRef === reported.externalRef &&
    stored.sentAt.getTime() === reported.sentAt.getTime()
  );
}

/**
 * Land a batch of reported messages on the session's thread.
 *
 * The thread is found by `(surface, locationRef, threadRef)`, so repeated
 * sessions on it extend one conversation. `surfaceMessageRef` decides what a
 * report means: an unknown one is a new message, a known one is an edit, and a
 * report that changes nothing is a no-op rather than an error. Reporting the
 * same batch twice therefore leaves the thread exactly as it was.
 *
 * Sequence numbers are handed out under a lock on the conversation row, so two
 * batches racing on one thread interleave without sharing a number. Text is
 * indexed after the batch commits: the index is a replica, and a failed index
 * write costs a search result, never a message.
 */
export async function captureMessages(
  db: Database,
  session: CaptureSession,
  input: { messages: CapturedMessageInput[]; now?: Date },
): Promise<CaptureMessagesResult> {
  const now = input.now ?? new Date();
  if (input.messages.length === 0) {
    throw new ConversationValidationError("Report at least one message");
  }
  if (input.messages.length > MESSAGE_BATCH_LIMIT) {
    throw new ConversationValidationError(
      `Report at most ${MESSAGE_BATCH_LIMIT} messages in one call`,
    );
  }
  const reported = input.messages.map(normalize);
  await assertAuthorsExist(db, session.orgId, reported);
  await resolveAuthors(db, session.orgId, session.surface, reported);

  const times = reported.flatMap((message) =>
    message.operation === "upsert" ? message.sentAt.getTime() : [],
  );
  const span = {
    earliest: times.length > 0 ? new Date(Math.min(...times)) : now,
    latest: times.length > 0 ? new Date(Math.max(...times)) : now,
  };
  const threadRef = conversationThreadRef(session);
  const hasUpserts = reported.some((message) => message.operation === "upsert");
  const runCapture = (conversationId: string) =>
    db.$transaction(async (transaction) => {
    // Re-checked inside the transaction, on a fresh clock: the route's own
    // check runs before it, and a close or an expiry committing in between
    // must not let an ended session land a batch. A close that commits after
    // this read is concurrent with the capture, which is the ordinary case.
    const checkAt = input.now ?? new Date();
    const liveSession = await transaction.contextSession.findUniqueOrThrow({
      where: { orgId_id: { orgId: session.orgId, id: session.id } },
      select: { closedAt: true, expiresAt: true },
    });
    if (liveSession.closedAt) throw new SessionClosedError();
    if (liveSession.expiresAt.getTime() <= checkAt.getTime()) throw new SessionExpiredError();

    // The lock serializes concurrent batches on this thread. Everything below
    // reads and writes the thread's sequence, so it must be one writer at a
    // time; the unique index on (conversationId, seq) backstops it.
    await transaction.$queryRaw`
      SELECT "id" FROM "Conversation"
      WHERE "orgId" = ${session.orgId} AND "id" = ${conversationId}
      FOR UPDATE
    `;
    const conversation = await transaction.conversation.findUniqueOrThrow({
      where: { orgId_id: { orgId: session.orgId, id: conversationId } },
    });

    const stored = await transaction.message.findMany({
      where: {
        orgId: session.orgId,
        conversationId: conversation.id,
        surfaceMessageRef: { in: reported.map((message) => message.surfaceMessageRef) },
      },
    });
    const byRef = new Map(stored.map((message) => [message.surfaceMessageRef, message]));
    const highest = await transaction.message.aggregate({
      where: { orgId: session.orgId, conversationId: conversation.id },
      _max: { seq: true },
    });
    let nextSeq = (highest._max.seq ?? 0) + 1;

    const results: CapturedMessageResult[] = [];
    const landed: Message[] = [];
    const seen: ConversationParticipant[] = [];
    for (const message of reported) {
      const current = byRef.get(message.surfaceMessageRef);
      if (message.operation === "delete") {
        if (!current) {
          results.push({
            surfaceMessageRef: message.surfaceMessageRef,
            outcome: "not_found",
            seq: null,
          });
          continue;
        }
        await transaction.message.delete({
          where: { orgId_id: { orgId: session.orgId, id: current.id } },
        });
        byRef.delete(message.surfaceMessageRef);
        results.push({
          surfaceMessageRef: message.surfaceMessageRef,
          outcome: "deleted",
          seq: current.seq,
        });
        continue;
      }

      seen.push({ principalId: message.principalId, externalRef: message.externalRef });
      if (current && sameMessage(current, message)) {
        // Re-indexed all the same: re-reporting an unchanged message is the
        // stated repair for an index write that failed last time, so it has to
        // reach the index pass. The upsert there makes it a cheap no-op
        // otherwise.
        landed.push(current);
        results.push({
          surfaceMessageRef: message.surfaceMessageRef,
          outcome: "unchanged",
          seq: current.seq,
        });
        continue;
      }
      if (current) {
        // An edit keeps the message's place in the thread: the wording changed,
        // not when it was said.
        const updated = await transaction.message.update({
          where: { orgId_id: { orgId: session.orgId, id: current.id } },
          data: {
            text: message.text,
            sentAt: message.sentAt,
            authorPrincipalId: message.principalId,
            authorExternalRef: message.externalRef,
          },
        });
        byRef.set(message.surfaceMessageRef, updated);
        landed.push(updated);
        results.push({
          surfaceMessageRef: message.surfaceMessageRef,
          outcome: "updated",
          seq: updated.seq,
        });
        continue;
      }
      const created = await transaction.message.create({
        data: {
          orgId: session.orgId,
          conversationId: conversation.id,
          seq: nextSeq,
          surfaceMessageRef: message.surfaceMessageRef,
          authorPrincipalId: message.principalId,
          authorExternalRef: message.externalRef,
          sentAt: message.sentAt,
          text: message.text,
        },
      });
      nextSeq += 1;
      byRef.set(message.surfaceMessageRef, created);
      landed.push(created);
      results.push({
        surfaceMessageRef: message.surfaceMessageRef,
        outcome: "created",
        seq: created.seq,
      });
    }

    // The binding decides who may read a thread, so a rebound location takes
    // its conversation with it. The binding is read here rather than taken
    // from the session, whose scope is pinned at open: a still-valid session
    // from before a rebind must not move the conversation back. A location
    // with no binding row — a direct message — keeps the scope it has.
    const binding = await transaction.binding.findUnique({
      where: {
        orgId_surface_locationRef: {
          orgId: session.orgId,
          surface: conversation.surface,
          locationRef: conversation.locationRef,
        },
      },
      select: { scopeId: true },
    });
    const participants = mergeParticipants(readParticipants(conversation.participants), seen);
    const updated = await transaction.conversation.update({
      where: { orgId_id: { orgId: session.orgId, id: conversation.id } },
      data: {
        scopeId: binding?.scopeId ?? conversation.scopeId,
        participants: participants as unknown as Prisma.InputJsonValue,
        ...(times.length > 0
          ? {
              // The span only ever widens: a batch of older messages backdates
              // the thread's start, and one that arrives out of order never
              // pulls its last activity backwards.
              startedAt: new Date(
                Math.min(conversation.startedAt.getTime(), span.earliest.getTime()),
              ),
              lastActivityAt: new Date(
                Math.max(conversation.lastActivityAt.getTime(), span.latest.getTime()),
              ),
            }
          : {}),
      },
    });
    const messageCount = await transaction.message.count({
      where: { orgId: session.orgId, conversationId: conversation.id },
    });
    return {
      conversation: updated,
      previousScopeId: conversation.scopeId,
      results,
      landed,
      messageCount,
    };
  });

  const captured = await (async () => {
    for (let attempt = 0; ; attempt += 1) {
      const { conversation: found, started } = await ensureConversation(
        db,
        session,
        threadRef,
        span,
        hasUpserts,
      );
      try {
        return await runCapture(found.id);
      } catch (error) {
        // A batch that started the thread and was then refused must not leave
        // the empty conversation behind as a ghost. The guard on `messages:
        // none` keeps a concurrent batch's landed messages safe.
        if (
          started &&
          (error instanceof SessionClosedError || error instanceof SessionExpiredError)
        ) {
          await db.conversation.deleteMany({
            where: { orgId: session.orgId, id: found.id, messages: { none: {} } },
          });
        }
        // That same cleanup can take the row out from under a batch that
        // found it moments earlier. The thread is ensured again and the
        // capture retried, once: a second disappearance is not a race.
        if (attempt === 0 && isRecordNotFound(error)) continue;
        throw error;
      }
    }
  })();

  // Indexed after the batch commits, so a search-index failure cannot undo a
  // captured message. Deleted messages take their index rows with them through
  // the foreign key cascade.
  for (const message of captured.landed) await indexMessageSafely(db, message);

  const counts = tally(captured.results);
  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "session.messages",
      subject: captured.conversation.id,
      payload: {
        sessionId: session.id,
        scopeId: captured.conversation.scopeId,
        surface: captured.conversation.surface,
        ...counts,
        messageCount: captured.messageCount,
      },
    },
  });
  if (captured.previousScopeId !== captured.conversation.scopeId) {
    log.warn("Conversation moved with its binding", {
      conversationId: captured.conversation.id,
      fromScopeId: captured.previousScopeId,
      toScopeId: captured.conversation.scopeId,
    });
  }
  // Counts and ids only: what was said is the content this endpoint captures,
  // and it never reaches a log line.
  log.info("Conversation messages captured", {
    sessionId: session.id,
    conversationId: captured.conversation.id,
    scopeId: captured.conversation.scopeId,
    ...counts,
    messageCount: captured.messageCount,
  });

  return {
    conversation: captured.conversation,
    results: captured.results,
    messageCount: captured.messageCount,
    ...counts,
  };
}

function tally(results: CapturedMessageResult[]) {
  const count = (outcome: MessageOutcome) =>
    results.filter((result) => result.outcome === outcome).length;
  return {
    created: count("created"),
    updated: count("updated"),
    unchanged: count("unchanged"),
    deleted: count("deleted"),
    notFound: count("not_found"),
  };
}

/**
 * Write one message into the lexical index. The stored row is a replica of the
 * message text; the tsvector beside it is a generated column, so the index is
 * correct the moment the row lands.
 */
export async function indexMessage(
  db: Database,
  message: { orgId: string; id: string; text: string },
): Promise<void> {
  await db.$executeRaw`
    INSERT INTO "MessageSearchDoc" ("orgId", "messageId", "text")
    VALUES (${message.orgId}, ${message.id}, ${message.text})
    ON CONFLICT ("orgId", "messageId") DO UPDATE SET "text" = EXCLUDED."text"
  `;
}

/**
 * Index a message without letting the index decide whether the message exists.
 * A failure here is a gap in search, repaired by re-reporting the message or by
 * a rebuild; the transcript itself is already safe.
 */
export async function indexMessageSafely(
  db: Database,
  message: { orgId: string; id: string; text: string },
): Promise<void> {
  try {
    await indexMessage(db, message);
  } catch (error) {
    log.warn("Message search index write failed", {
      messageId: message.id,
      orgId: message.orgId,
      error,
    });
  }
}
