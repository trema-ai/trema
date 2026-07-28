import type { PrincipalLike } from "#web/lib/run-timeline.ts";

/**
 * The one state the web app holds (web 00): what the member just did that the
 * server reads have not caught up with yet. A module store rather than
 * component state because two screens read it — the chat thread (a run
 * started by the composer, rendered before the thread-runs read returns) and
 * the sidebar (a just-created chat, listed before its conversation row lands
 * when the first run reports). Everything here is provisional by construction
 * and pruned the moment the corresponding server read carries the fact.
 */

/** A chat the member just started, listed until its conversation row lands. */
export interface DraftThread {
  threadRef: string;
  title: string;
  createdAt: string;
}

/**
 * A run the intent endpoint reported as `started`, rendered from the 2xx (a
 * durable fact) until the thread-runs read lists it. Shaped like the read's
 * rows so the thread renders both through one path.
 */
export interface PlaceholderRun {
  id: string;
  state: "queued";
  trigger: "message";
  createdAt: string;
  openingMessage: { author: PrincipalLike; text: string };
}

interface ChatViewState {
  drafts: readonly DraftThread[];
  /** Placeholder runs by threadRef. */
  runs: Readonly<Record<string, readonly PlaceholderRun[]>>;
}

let state: ChatViewState = { drafts: [], runs: {} };
const listeners = new Set<() => void>();

function replace(next: ChatViewState): void {
  state = next;
  for (const listener of listeners) listener();
}

export function subscribeChatViewState(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function chatViewStateSnapshot(): ChatViewState {
  return state;
}

/** Records a `started` outcome: the run placeholder, and the draft thread. */
export function recordStartedRun(threadRef: string, run: PlaceholderRun): void {
  const existing = state.runs[threadRef] ?? [];
  if (existing.some((entry) => entry.id === run.id)) return;
  const known = state.drafts.some((draft) => draft.threadRef === threadRef);
  replace({
    drafts: known
      ? state.drafts
      : [...state.drafts, { threadRef, title: run.openingMessage.text, createdAt: run.createdAt }],
    runs: { ...state.runs, [threadRef]: [...existing, run] },
  });
}

/** Drops placeholders the thread-runs read now lists. */
export function prunePlaceholderRuns(threadRef: string, listedRunIds: readonly string[]): void {
  const existing = state.runs[threadRef] ?? [];
  const kept = existing.filter((entry) => !listedRunIds.includes(entry.id));
  if (kept.length === existing.length) return;
  const runs = { ...state.runs };
  if (kept.length === 0) delete runs[threadRef];
  else runs[threadRef] = kept;
  replace({ drafts: state.drafts, runs });
}

/** Drops draft threads the conversation list now carries. */
export function pruneDraftThreads(listedThreadRefs: readonly string[]): void {
  const kept = state.drafts.filter((draft) => !listedThreadRefs.includes(draft.threadRef));
  if (kept.length === state.drafts.length) return;
  replace({ drafts: kept, runs: state.runs });
}
