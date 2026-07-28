import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useSyncExternalStore } from "react";

import type { ThreadSummary } from "#web/components/trema/app-sidebar.tsx";
import { orpc } from "#web/lib/api.ts";
import {
  chatViewStateSnapshot,
  pruneDraftThreads,
  subscribeChatViewState,
} from "#web/lib/chat-state.ts";

/**
 * Threads with activity inside this window sort in stable start order rather
 * than by recency, so an actively-streaming thread does not reshuffle the
 * list under the pointer (the opencode stability rule, pragmatically).
 */
const ACTIVITY_STABILITY_MS = 60_000;

/** How long a title can get before the tooltip carries the rest. */
const TITLE_LIMIT = 80;

interface OrderableThread extends ThreadSummary {
  startedAt: string;
  lastActivityAt: string;
}

function title(text: string | null): string {
  const trimmed = text?.trim() ?? "";
  if (trimmed === "") return "New chat";
  return trimmed.length > TITLE_LIMIT ? `${trimmed.slice(0, TITLE_LIMIT)}…` : trimmed;
}

/** Newest activity first, with the stability window applied. */
export function orderThreads(threads: readonly OrderableThread[], now: number): ThreadSummary[] {
  const recent = (thread: OrderableThread) =>
    now - Date.parse(thread.lastActivityAt) < ACTIVITY_STABILITY_MS;
  return [...threads]
    .sort((a, b) => {
      const aRecent = recent(a);
      if (aRecent !== recent(b)) return aRecent ? -1 : 1;
      if (aRecent) return Date.parse(b.startedAt) - Date.parse(a.startedAt);
      return Date.parse(b.lastActivityAt) - Date.parse(a.lastActivityAt);
    })
    .map(({ threadRef, title: threadTitle }) => ({ threadRef, title: threadTitle }));
}

/**
 * The sidebar's thread list: the member's web conversations, newest activity
 * first, with just-created chats carried in view state until their
 * conversation row lands (it exists only once the first run reports).
 */
export function useWebThreads(): ThreadSummary[] {
  const conversations = useQuery(
    orpc.conversations.list.queryOptions({ input: { surface: "web" } }),
  );
  const viewState = useSyncExternalStore(subscribeChatViewState, chatViewStateSnapshot);
  const rows = conversations.data?.conversations;

  // A draft thread is provisional by construction: once the conversation row
  // exists, the server read owns the fact.
  useEffect(() => {
    if (rows !== undefined) pruneDraftThreads(rows.map((row) => row.threadRef));
  }, [rows]);

  return useMemo(() => {
    const listed = rows ?? [];
    const known = new Set(listed.map((row) => row.threadRef));
    const merged: OrderableThread[] = [
      ...viewState.drafts
        .filter((draft) => !known.has(draft.threadRef))
        .map((draft) => ({
          threadRef: draft.threadRef,
          title: title(draft.title),
          startedAt: draft.createdAt,
          lastActivityAt: draft.createdAt,
        })),
      ...listed.map((row) => ({
        threadRef: row.threadRef,
        title: title(row.firstMessageText),
        startedAt: row.startedAt,
        lastActivityAt: row.lastActivityAt,
      })),
    ];
    return orderThreads(merged, Date.now());
  }, [rows, viewState.drafts]);
}
