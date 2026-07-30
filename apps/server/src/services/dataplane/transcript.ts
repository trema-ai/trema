import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import type { ConversationParticipant } from "#server/services/conversations/index.js";
import {
  DataPlaneConversationNotFoundError,
  type DataPlaneSession,
} from "#server/services/dataplane/index.js";

/** How many messages a transcript window holds when the caller asks for no size. */
export const FETCH_TRANSCRIPT_DEFAULT_WINDOW = 20;

/** The most messages one `fetch_transcript` call may return. */
export const FETCH_TRANSCRIPT_MAX_WINDOW = 100;

export interface FetchTranscriptInput {
  conversationId: string;
  /** Centre the window on this message. Omit it for the end of the thread. */
  aroundSeq?: number;
  window?: number;
}

export interface TranscriptMessage {
  seq: number;
  sentAt: Date;
  authorPrincipalId: string | null;
  authorExternalRef: string | null;
  text: string;
}

export interface Transcript {
  conversationId: string;
  scopeId: string;
  surface: string;
  locationRef: string;
  threadRef: string;
  participants: ConversationParticipant[];
  startedAt: Date;
  lastActivityAt: Date;
  /** How many messages the whole conversation holds. */
  messageCount: number;
  /** The lowest and highest sequence numbers in the conversation, or null when it is empty. */
  firstSeq: number | null;
  lastSeq: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  messages: TranscriptMessage[];
}

const selection = {
  seq: true,
  sentAt: true,
  authorPrincipalId: true,
  authorExternalRef: true,
  text: true,
} as const;

function boundedWindow(size: number | undefined): number {
  if (size === undefined) return FETCH_TRANSCRIPT_DEFAULT_WINDOW;
  return Math.min(Math.max(Math.trunc(size), 1), FETCH_TRANSCRIPT_MAX_WINDOW);
}

function readParticipants(value: unknown): ConversationParticipant[] {
  return Array.isArray(value) ? (value as ConversationParticipant[]) : [];
}

/**
 * Read a bounded window of a conversation's raw messages.
 *
 * Bounded by design: there is no call that returns a whole channel. With
 * `aroundSeq` the window sits around that message, with about half of it
 * before; without one it is the end of the thread, which is what a run
 * catching up on a conversation wants.
 *
 * The conversation must sit in the session's scope chain. One that does not
 * reports exactly like a conversation that does not exist — a distinct refusal
 * would let a run learn that another person's thread is there.
 */
export async function fetchTranscript(
  db: Database,
  session: DataPlaneSession,
  input: FetchTranscriptInput,
): Promise<Transcript> {
  const conversation = await db.conversation.findFirst({
    where: {
      id: input.conversationId,
      orgId: session.orgId,
      scopeId: { in: session.scopeChain },
    },
  });
  if (!conversation) {
    log.warn("Transcript not readable", {
      sessionId: session.id,
      conversationId: input.conversationId,
    });
    throw new DataPlaneConversationNotFoundError();
  }

  const window = boundedWindow(input.window);
  const where = { orgId: session.orgId, conversationId: conversation.id };
  const [bounds, messageCount] = await Promise.all([
    db.message.aggregate({ where, _min: { seq: true }, _max: { seq: true } }),
    db.message.count({ where }),
  ]);

  const firstSeq = bounds._min.seq ?? null;
  const lastSeq = bounds._max.seq ?? null;

  let messages: TranscriptMessage[];
  if (input.aroundSeq === undefined || firstSeq === null || lastSeq === null) {
    // The end of the thread, read backwards and turned around, so the window
    // is the most recent messages in reading order. An empty conversation
    // takes this path too, whatever the caller anchored on.
    const recent = await db.message.findMany({
      where,
      orderBy: { seq: "desc" },
      take: window,
      select: selection,
    });
    messages = recent.reverse();
  } else {
    // About half the window sits before the message asked for. An anchor
    // outside the thread clamps to its nearest end, so paging past either end
    // returns the edge window rather than nothing.
    const anchor = Math.min(Math.max(Math.trunc(input.aroundSeq), firstSeq), lastSeq);
    const before = Math.floor((window - 1) / 2);
    messages = await db.message.findMany({
      where: { ...where, seq: { gte: anchor - before } },
      orderBy: { seq: "asc" },
      take: window,
      select: selection,
    });
  }
  const windowFirst = messages[0]?.seq;
  const windowLast = messages[messages.length - 1]?.seq;
  const transcript: Transcript = {
    conversationId: conversation.id,
    scopeId: conversation.scopeId,
    surface: conversation.surface,
    locationRef: conversation.locationRef,
    threadRef: conversation.threadRef,
    participants: readParticipants(conversation.participants),
    startedAt: conversation.startedAt,
    lastActivityAt: conversation.lastActivityAt,
    messageCount,
    firstSeq,
    lastSeq,
    hasMoreBefore: windowFirst !== undefined && firstSeq !== null && windowFirst > firstSeq,
    hasMoreAfter: windowLast !== undefined && lastSeq !== null && windowLast < lastSeq,
    messages,
  };

  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.agentPrincipalId,
      action: "dataplane.fetch_transcript",
      subject: conversation.id,
      payload: {
        sessionId: session.id,
        scopeId: conversation.scopeId,
        window,
        aroundSeq: input.aroundSeq ?? null,
        returnedCount: messages.length,
        messageCount,
      },
    },
  });
  log.info("Transcript read", {
    sessionId: session.id,
    conversationId: conversation.id,
    window,
    returnedCount: messages.length,
    messageCount,
  });
  return transcript;
}
