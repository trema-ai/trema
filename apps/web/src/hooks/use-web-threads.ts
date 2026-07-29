import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState, useSyncExternalStore } from "react";

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

/** While any thread sits inside the window, the ordering re-evaluates on this cadence. */
const STABILITY_TICK_MS = 20_000;

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

  const merged = useMemo<OrderableThread[]>(() => {
    const listed = rows ?? [];
    const known = new Set(listed.map((row) => row.threadRef));
    return [
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
  }, [rows, viewState.drafts]);

  // The window is a clock fact, so a thread inside it must leave on its own,
  // not on the next unrelated rerender: a tick re-sorts while at least one
  // thread is inside the window, and no timer runs when none is.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const current = Date.now();
    // Catch the frozen clock up first when a change lands after a quiet
    // stretch; the rerun then decides whether a timer is needed at all.
    if (current - now > STABILITY_TICK_MS) {
      setNow(current);
      return;
    }
    const anyInside = merged.some(
      (thread) => current - Date.parse(thread.lastActivityAt) < ACTIVITY_STABILITY_MS,
    );
    if (!anyInside) return;
    const timer = setInterval(() => setNow(Date.now()), STABILITY_TICK_MS);
    return () => clearInterval(timer);
  }, [merged, now]);

  return useMemo(() => orderThreads(merged, now), [merged, now]);
}
