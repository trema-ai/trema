import type { PrincipalRef, QueuedInput, RunRecord, TranscriptMessage } from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";
import {
  type CapturedMessageInput,
  type CaptureSession,
  captureMessages,
  MESSAGE_BATCH_LIMIT,
} from "#server/services/conversations/index.js";

/** A queued input and the moment it was queued, which is when it was said. */
export interface QueuedMessage extends QueuedInput {
  queuedAt: Date;
}

/**
 * Reports the messages a run opened with.
 *
 * The driver holds this rather than a database: what a message is reported to
 * — the context app in process here, an HTTP session elsewhere — is not the
 * run loop's business.
 */
export type CaptureOpeningMessages = (run: RunRecord) => Promise<void>;

/** Tenancy and persistence for the in-process capture. */
export interface RunCaptureOptions {
  db: Database;
  orgId: string;
}

function messageText(message: TranscriptMessage): string {
  return message.blocks.flatMap((block) => (block.type === "text" ? [block.text] : [])).join("\n");
}

/**
 * The captured form of what a run was asked to do.
 *
 * The queue entry's id is the `surfaceMessageRef`, and it is the intent id the
 * caller sent: a redelivered execution reports the same reference, so the
 * capture upserts instead of saying the same thing twice.
 *
 * Only a person's message is captured. A run a service credential or a
 * schedule started has an agent for an author, and a conversation is what
 * people said — the machinery's own prompts are audit, not context.
 * A message with no text — an image, or blocks a surface added later — has
 * nothing to index, and reporting it would refuse the whole batch.
 */
export function openingMessages(
  queued: readonly QueuedMessage[],
  humanPrincipalIds: ReadonlySet<string>,
): CapturedMessageInput[] {
  return queued.flatMap((input) => {
    if (!humanPrincipalIds.has(input.author.principalId)) return [];
    const text = messageText(input.message);
    if (!text.trim()) return [];
    return [
      {
        surfaceMessageRef: input.id,
        author: { principalId: input.author.principalId },
        sentAt: input.queuedAt,
        text,
      },
    ];
  });
}

/**
 * Splits a capture into batches the conversation service accepts.
 *
 * A report is capped at {@link MESSAGE_BATCH_LIMIT} messages, and what a run
 * opened with is however much was said before it started — a queue longer than
 * the cap must still be reported, because the loop drains it either way and a
 * refused batch would lose it for good. Batches keep queue order and are landed
 * one after another, so the thread's sequence reads as it was said.
 */
export function messageBatches(
  messages: readonly CapturedMessageInput[],
  limit: number = MESSAGE_BATCH_LIMIT,
): CapturedMessageInput[][] {
  const batches: CapturedMessageInput[][] = [];
  for (let start = 0; start < messages.length; start += limit) {
    batches.push(messages.slice(start, start + limit));
  }
  return batches;
}

/**
 * Lands batches in order and stops at the first failure.
 *
 * What lands is always a prefix of the queue. The conversation orders its
 * transcript by arrival, so a batch landed past a failed one would put the
 * failed batch's messages after it if a redelivered execution reports them —
 * a scrambled transcript, where stopping merely truncates it. A redelivery
 * before the loop drains the queue re-reports everything: the landed prefix
 * upserts unchanged and the rest extends it, still in order.
 */
export async function reportBatches(
  batches: readonly (readonly CapturedMessageInput[])[],
  report: (batch: readonly CapturedMessageInput[]) => Promise<void>,
): Promise<void> {
  for (const [index, batch] of batches.entries()) {
    try {
      await report(batch);
    } catch (error) {
      throw new Error(`capture stopped at batch ${index + 1} of ${batches.length}`, {
        cause: error,
      });
    }
  }
}

/**
 * Reports a run's opening message to the conversation its session names.
 *
 * The message is read from the steering queue, where dispatch left it: the
 * loop drains it at the first turn boundary, so a capture that ran any later
 * would find nothing. The session is the one the run pinned, which is what
 * puts the conversation on the right thread and at the right scope.
 */
export function createRunCapture(options: RunCaptureOptions): CaptureOpeningMessages {
  return async (run) => {
    // A run with no session has no thread identity to report against.
    if (run.sessionId === undefined) return;

    const rows = await options.db.runQueuedInput.findMany({
      where: { orgId: options.orgId, kind: "steering", runId: run.id },
      orderBy: { position: "asc" },
      select: { id: true, message: true, author: true, createdAt: true },
    });
    const queued: QueuedMessage[] = rows.flatMap((row) => {
      const author = row.author as unknown as PrincipalRef | null;
      if (typeof author?.principalId !== "string") return [];
      return [
        {
          id: row.id,
          author,
          message: row.message as unknown as TranscriptMessage,
          queuedAt: row.createdAt,
        },
      ];
    });
    if (queued.length === 0) return;

    const humans = await options.db.principal.findMany({
      where: {
        orgId: options.orgId,
        kind: "human",
        id: { in: [...new Set(queued.map(({ author }) => author.principalId))] },
      },
      select: { id: true },
    });
    const messages = openingMessages(queued, new Set(humans.map(({ id }) => id)));
    if (messages.length === 0) return;

    const session = await options.db.contextSession.findFirst({
      where: { orgId: options.orgId, id: run.sessionId },
      select: {
        id: true,
        orgId: true,
        scopeId: true,
        surface: true,
        locationRef: true,
        threadRef: true,
        agentPrincipalId: true,
      },
    });
    // The plan reads the same session moments later and fails the run with a
    // message when it is gone. Refusing here would only say it worse.
    if (session === null) return;

    await reportBatches(messageBatches(messages), async (batch) => {
      await captureMessages(options.db, session satisfies CaptureSession, {
        messages: [...batch],
      });
    });
  };
}
