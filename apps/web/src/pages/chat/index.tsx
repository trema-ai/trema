import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router";

import { ChatBubble } from "#web/components/trema/chat-bubble.tsx";
import { ChatComposer } from "#web/components/trema/chat-composer.tsx";
import { ErrorItem } from "#web/components/trema/error-item.tsx";
import { type ModelOption, ModelSelector } from "#web/components/trema/model-selector.tsx";
import { PersonalScopesNotice } from "#web/components/trema/personal-scopes-notice.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { useStickToBottom } from "#web/hooks/use-stick-to-bottom.ts";
import { orpc, rpcClient } from "#web/lib/api.ts";
import {
  chatViewStateSnapshot,
  prunePlaceholderRuns,
  recordStartedRun,
  subscribeChatViewState,
} from "#web/lib/chat-state.ts";
import { intentErrorCode, messageFrom, submitIntent } from "#web/lib/intents.ts";
import {
  type ModelSelection,
  modelSelectionSnapshot,
  modelSelectionValue,
  resolveModelSelection,
  setModelSelection,
  subscribeModelSelection,
} from "#web/lib/model-selection.ts";
import { isTerminalRunState, type PrincipalLike } from "#web/lib/run-timeline.ts";
import { ulid } from "#web/lib/ulid.ts";
import { cn } from "#web/lib/utils.ts";
import { RunBlock, type RunBlockFacts, type ThreadRun } from "#web/pages/chat/run-block.tsx";
import { useAuthenticatedSession, useViewerRole } from "#web/pages/home.tsx";
import type { QueuedInputItem } from "#web/pages/runs/timeline.tsx";

/**
 * The chat surface: `/` is a new chat — a client-minted threadRef and
 * nothing durable, since the first message intent is what brings the thread
 * into being (web 06) — and `/chat/:threadRef` is an existing thread. Both
 * render the same component under a key of the threadRef, so the first send
 * navigates `/` → `/chat/:threadRef` without remounting: pure view state,
 * no server round-trip.
 */
export function ChatPage() {
  const params = useParams();
  const [minted, setMinted] = useState(() => ulid());
  // Returning to `/` from a thread starts a fresh chat: re-mint during
  // render exactly when the param transitions back to absent.
  const previousParam = useRef(params.threadRef);
  if (previousParam.current !== params.threadRef) {
    previousParam.current = params.threadRef;
    if (params.threadRef === undefined) setMinted(ulid());
  }
  const threadRef = params.threadRef ?? minted;
  return (
    <ChatThread key={threadRef} threadRef={threadRef} isNew={params.threadRef === undefined} />
  );
}

/** A send the 2xx certified but the reads have not caught up with yet. */
interface PendingSendBase {
  id: string;
  text: string;
  queuedAt: string;
}

interface PendingSteer extends PendingSendBase {
  kind: "steering";
  /** The run the steer targeted, when the view knew one at send time. */
  runId: string | undefined;
  /**
   * Steering parts already on that run's projection when the 2xx landed.
   * Null when the projection had not reported yet — resolved to the first
   * observed count, since a send-time zero would count historical steers
   * with the same text as this one landing.
   */
  baseline: number | null;
}

interface PendingFollowUp extends PendingSendBase {
  kind: "follow_up";
}

type PendingSend = PendingSteer | PendingFollowUp;

function ChatThread({ threadRef, isNew }: { threadRef: string; isNew: boolean }) {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const session = useAuthenticatedSession();
  const role = useViewerRole();
  const principal = session.membership.principal;
  const author: PrincipalLike = useMemo(
    () => ({ principalId: principal.id, displayName: principal.displayName }),
    [principal.id, principal.displayName],
  );

  // ----- the thread's runs: the server list plus started-run placeholders --
  const runsQuery = useQuery(
    orpc.runs.listByThread.queryOptions({ input: { threadRef }, enabled: !isNew }),
  );
  const viewState = useSyncExternalStore(subscribeChatViewState, chatViewStateSnapshot);
  const placeholders = viewState.runs[threadRef];
  const serverRuns = runsQuery.data?.runs;
  const runs: ThreadRun[] = useMemo(() => {
    const byId = new Map((placeholders ?? []).map((run) => [run.id, run]));
    // The server row owns a listed run, but until the first turn drains the
    // opening into the log its derived openingMessage is null — the
    // placeholder backfills it (and the intent id that suppresses the
    // still-queued opening row) so the bubble never flickers away.
    const listed: ThreadRun[] = (serverRuns ?? []).map((run) => {
      const placeholder = byId.get(run.id);
      if (placeholder === undefined || run.openingMessage !== null) return run;
      return {
        ...run,
        openingMessage: placeholder.openingMessage,
        openingIntentId: placeholder.openingIntentId,
      };
    });
    const known = new Set(listed.map((run) => run.id));
    const extra = (placeholders ?? []).filter((run) => !known.has(run.id));
    return [...listed, ...extra].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );
  }, [serverRuns, placeholders]);

  // A placeholder is provisional: once the thread-runs read lists the run
  // with its opening derived from the log, the server read owns it whole.
  // Until then the placeholder stays — it is what backfills the opening.
  useEffect(() => {
    if (serverRuns !== undefined && serverRuns.length > 0) {
      prunePlaceholderRuns(
        threadRef,
        serverRuns.flatMap((run) => (run.openingMessage === null ? [] : [run.id])),
      );
    }
  }, [threadRef, serverRuns]);

  // ----- what the tails report: live/settled state and drained steering ----
  const [facts, setFacts] = useState<Record<string, RunBlockFacts>>({});
  const handleFacts = useCallback((runId: string, next: RunBlockFacts) => {
    setFacts((previous) => ({ ...previous, [runId]: next }));
  }, []);

  const lastRun = runs.at(-1);
  const lastFacts = lastRun === undefined ? undefined : facts[lastRun.id];
  // Runs serialize per thread, so only the newest can be active. Until its
  // tail reports, the header state from the list decides.
  const activeRunId =
    lastRun !== undefined && !(lastFacts?.settled ?? isTerminalRunState(lastRun.state))
      ? lastRun.id
      : undefined;

  // A terminal on the tail is the cue to refetch the thread's runs — a
  // follow-up may have started — and the conversation list's ordering moved.
  const wasActiveRef = useRef<string | undefined>(undefined);
  const [stopping, setStopping] = useState(false);
  useEffect(() => {
    if (activeRunId !== undefined) {
      wasActiveRef.current = activeRunId;
      return;
    }
    if (wasActiveRef.current === undefined) return;
    wasActiveRef.current = undefined;
    setStopping(false);
    void queryClient.invalidateQueries({ queryKey: orpc.runs.listByThread.key() });
    void queryClient.invalidateQueries({ queryKey: orpc.conversations.list.key() });
    // The settled run's read is refetched too: undrained input surviving the
    // run is server data this screen keeps rendering.
    void queryClient.invalidateQueries({ queryKey: orpc.runs.get.key() });
  }, [activeRunId, queryClient]);

  // ----- pending input: queuedInput on the run read plus fresh 2xx sends ---
  // The read follows the thread's last run whether or not it is still
  // active: input a settled run never drained stays visible from server
  // data, never invisible.
  const lastRunId = lastRun?.id;
  const lastRunQuery = useQuery(
    orpc.runs.get.queryOptions({
      input: { id: lastRunId ?? "" },
      enabled: lastRunId !== undefined,
    }),
  );
  // The opening message sits in the run's queued input under its send's
  // intent id until the first turn drains it. The thread already renders it
  // as the opening bubble, so that one row never renders as queued too.
  const openingIntentIds = useMemo(
    () =>
      new Set(
        runs.flatMap((run) => (run.openingIntentId === undefined ? [] : [run.openingIntentId])),
      ),
    [runs],
  );
  const queuedInput = useMemo<QueuedInputItem[]>(
    () =>
      lastRunId !== undefined && lastRunQuery.data?.access === "full"
        ? lastRunQuery.data.queuedInput.filter((row) => !openingIntentIds.has(row.id))
        : [],
    [lastRunId, lastRunQuery.data, openingIntentIds],
  );
  const [pendingSends, setPendingSends] = useState<PendingSend[]>([]);

  // A steering part landing on the tail is the drain point: refetch the run
  // read so its queuedInput drops the drained row.
  const steeringCount = lastFacts?.steeringTexts.length ?? 0;
  const previousSteeringRef = useRef(steeringCount);
  useEffect(() => {
    if (steeringCount > previousSteeringRef.current) {
      void queryClient.invalidateQueries({ queryKey: orpc.runs.get.key() });
    }
    previousSteeringRef.current = steeringCount;
  }, [steeringCount, queryClient]);

  // A local pending steer ends only once its note is visible somewhere
  // else: when its steering part shows on the target run's folded
  // projection, or — after the run settled and a fresh full read confirmed
  // the queue no longer carries it — when the server record is all there is
  // to show. A bare timestamp race never drops one: dropped-but-not-yet-
  // folded is exactly the flicker the acknowledgement rules forbid.
  const lastRunState = lastRun?.state;
  useEffect(() => {
    setPendingSends((previous) => {
      // A baseline captured before the run's projection reported resolves to
      // the first observed count. That snapshot may already include the
      // steer's own part, in which case the note lingers until the settle
      // rule below clears it — the safe direction; a zero would instead let
      // historical same-text parts (the opening included) drop the note
      // before its part folded.
      let rebaselined = false;
      const resolved = previous.map((entry) => {
        if (entry.kind !== "steering" || entry.baseline !== null) return entry;
        const targetId = entry.runId ?? lastRunId;
        if (targetId === undefined) return entry;
        const observed = facts[targetId];
        if (observed === undefined) return entry;
        rebaselined = true;
        return { ...entry, baseline: observed.steeringTexts.length };
      });
      const next = resolved.filter((entry, index) => {
        if (entry.kind !== "steering") return true;
        const targetId = entry.runId ?? lastRunId;
        if (targetId === undefined) return true;
        // The part landed: beyond the send-time baseline, one projection
        // occurrence of the text per pending steer, oldest first. A still-
        // null baseline means no facts, so nothing to count against.
        const texts = facts[targetId]?.steeringTexts ?? [];
        const landed = texts
          .slice(entry.baseline ?? 0)
          .filter((text) => text === entry.text).length;
        const earlier = resolved.filter(
          (other, position) =>
            position < index &&
            other.kind === "steering" &&
            (other.runId ?? lastRunId) === targetId &&
            other.text === entry.text,
        ).length;
        if (landed > earlier) return false;
        // The run settled with the steer neither folded (above) nor queued
        // on a read fresher than the send: whatever the server says is the
        // whole record now. A settled run's log is complete, so a drained
        // steer would have matched — reaching here means it is gone.
        if (targetId !== lastRunId || lastRunQuery.data?.access !== "full") return true;
        const settled = facts[targetId]?.settled ?? isTerminalRunState(lastRunState);
        return !(
          settled &&
          lastRunQuery.dataUpdatedAt > Date.parse(entry.queuedAt) &&
          !lastRunQuery.data.queuedInput.some((item) => item.id === entry.id)
        );
      });
      return !rebaselined && next.length === previous.length ? previous : next;
    });
  }, [facts, lastRunId, lastRunState, lastRunQuery.data, lastRunQuery.dataUpdatedAt]);

  // A pending follow-up ends when the run that drained it appears on the
  // thread. Each new run drains exactly one queued message, so a run may
  // consume at most one pending entry — oldest matching first — and a
  // second identical-text follow-up stays visible until its own run lands.
  const consumedRunsRef = useRef(new Set<string>());
  useEffect(() => {
    if (serverRuns === undefined) return;
    setPendingSends((previous) => {
      if (!previous.some((entry) => entry.kind === "follow_up")) return previous;
      const consumed = consumedRunsRef.current;
      const remaining = [...previous];
      let changed = false;
      for (const run of serverRuns) {
        const opening = run.openingMessage;
        if (opening === null || consumed.has(run.id)) continue;
        if (opening.author.principalId !== principal.id) continue;
        const index = remaining.findIndex(
          (entry) =>
            entry.kind === "follow_up" &&
            run.createdAt >= entry.queuedAt &&
            entry.text === opening.text,
        );
        if (index === -1) continue;
        consumed.add(run.id);
        remaining.splice(index, 1);
        changed = true;
      }
      return changed ? remaining : previous;
    });
  }, [serverRuns, principal.id]);

  const pendingDisplay = useMemo<QueuedInputItem[]>(() => {
    const listed = new Set(queuedInput.map((item) => item.id));
    const locals = pendingSends
      .filter((entry) => !listed.has(entry.id))
      .map((entry, index) => ({
        id: entry.id,
        kind: entry.kind,
        text: entry.text,
        author,
        position: Number.MAX_SAFE_INTEGER - pendingSends.length + index,
        queuedAt: entry.queuedAt,
      }));
    return [...queuedInput, ...locals];
  }, [queuedInput, pendingSends, author]);

  // ----- the composer: message intents in, acknowledgements from the log --
  const [draft, setDraft] = useState("");
  const [sendError, setSendError] = useState<string>();
  const [personalDisabled, setPersonalDisabled] = useState(false);
  const policy = useQuery(orpc.scopes.personalPolicy.queryOptions({ input: {} }));
  const personalOff = personalDisabled || policy.data?.enabled === false;

  const offeredModels = useQuery(orpc.modelProviders.models.offered.queryOptions({ input: {} }));
  const storedModel = useSyncExternalStore(
    subscribeModelSelection,
    modelSelectionSnapshot,
    modelSelectionSnapshot,
  );
  // There is no "Default" row: the org's turns default is just the entry
  // pre-selected until the member picks another (first entry when the read
  // marks none). What the picker shows is exactly what the run gets.
  const stored = resolveModelSelection(storedModel, offeredModels.data ?? []);
  const selectedModel =
    stored ??
    offeredModels.data?.find((model) => model.default === true) ??
    offeredModels.data?.[0];
  useEffect(() => {
    if (storedModel !== undefined && offeredModels.isSuccess && stored === undefined) {
      setModelSelection(undefined);
    }
  }, [offeredModels.isSuccess, stored, storedModel]);

  const modelOptions = useMemo<ModelOption[]>(
    () =>
      (offeredModels.data ?? []).map((model) => ({
        id: modelSelectionValue(model),
        name: model.label,
        keywords: [model.providerName, model.modelId],
      })),
    [offeredModels.data],
  );

  const sendMutation = useMutation({
    mutationFn: (input: { intentId: string; text: string; model?: ModelSelection }) =>
      rpcClient.intents.submit({
        intentId: input.intentId,
        threadRef,
        intent: {
          type: "message",
          text: input.text,
          ...(input.model === undefined ? {} : { model: input.model }),
        },
      }),
  });

  function handleSend() {
    const text = draft.trim();
    if (text === "" || sendMutation.isPending) return;
    const intentId = crypto.randomUUID();
    setDraft("");
    setSendError(undefined);
    sendMutation.mutate(
      {
        intentId,
        text,
        ...(selectedModel === undefined
          ? {}
          : {
              model: {
                providerName: selectedModel.providerName,
                modelId: selectedModel.modelId,
              },
            }),
      },
      {
        onSuccess: (result) => {
          const queuedAt = new Date().toISOString();
          if (result.outcome === "started" && result.runId !== null) {
            // The 2xx certifies a durable run: render it now, from view
            // state, until the thread-runs read lists it. Its opening
            // message is this send, so it can never drain a follow-up.
            consumedRunsRef.current.add(result.runId);
            recordStartedRun(threadRef, {
              id: result.runId,
              state: "queued",
              trigger: "message",
              createdAt: queuedAt,
              openingMessage: { author, text },
              openingIntentId: intentId,
            });
            if (isNew) void navigate(`/chat/${threadRef}`);
          } else if (result.outcome === "steered") {
            // The target run and its current steering count anchor the
            // reconciliation: the steer's own part is the one that shows up
            // past this baseline. An unreported projection leaves it null
            // for the first facts observation to resolve.
            const runId = activeRunId;
            const baseline =
              runId === undefined ? null : (facts[runId]?.steeringTexts.length ?? null);
            setPendingSends((previous) => [
              ...previous,
              { id: intentId, kind: "steering", runId, baseline, text, queuedAt },
            ]);
            void queryClient.invalidateQueries({ queryKey: orpc.runs.get.key() });
          } else if (result.outcome === "follow-up") {
            setPendingSends((previous) => [
              ...previous,
              { id: intentId, kind: "follow_up", text, queuedAt },
            ]);
            void queryClient.invalidateQueries({ queryKey: orpc.runs.get.key() });
          } else {
            // A duplicate is a retried post: the original outcome is already
            // durable somewhere on the thread, so refetch rather than guess.
            void queryClient.invalidateQueries({ queryKey: orpc.runs.listByThread.key() });
          }
          void queryClient.invalidateQueries({ queryKey: orpc.conversations.list.key() });
        },
        onError: (cause) => {
          // A failed POST is a visibly unsent message: the draft comes back
          // (unless something new was typed meanwhile) with the error above.
          setDraft((current) => (current === "" ? text : current));
          if (intentErrorCode(cause) === "personal_scopes_disabled") {
            setPersonalDisabled(true);
            return;
          }
          setSendError(messageFrom(cause));
        },
      },
    );
  }

  // The composer's stop mirrors the run block's: pressed until the cancelled
  // terminal arrives on the tail and ends the active run.
  const stopMutation = useMutation({
    mutationFn: (runId: string) => submitIntent({ type: "stop", runId }),
    onMutate: () => {
      setStopping(true);
    },
    onError: (cause) => {
      // `run_not_active` means the run settled on its own first; the
      // terminal about to land resets this control, so stay pressed.
      if (intentErrorCode(cause) === "run_not_active") return;
      setStopping(false);
      setSendError(messageFrom(cause));
    },
  });

  // ----- the reading column ------------------------------------------------
  const { viewportRef, contentRef, away, scrollToBottom } = useStickToBottom();
  const isEmpty = runs.length === 0 && pendingDisplay.length === 0;
  // A new chat's runs query is disabled, which TanStack reports as pending.
  const loadingRuns = !isNew && runsQuery.isPending;
  const docked = !isEmpty || loadingRuns;
  const composer = personalOff ? (
    <PersonalScopesNotice canManage={role === "owner" || role === "admin"} />
  ) : (
    <ChatComposer
      value={draft}
      onValueChange={setDraft}
      onSend={handleSend}
      onStop={activeRunId === undefined ? undefined : () => stopMutation.mutate(activeRunId)}
      stopping={stopping}
      error={sendError}
      autoFocus
      actions={
        offeredModels.isSuccess && offeredModels.data.length > 0 ? (
          <ModelSelector
            models={modelOptions}
            value={selectedModel === undefined ? "" : modelSelectionValue(selectedModel)}
            onValueChange={(value) => {
              const next = offeredModels.data.find((model) => modelSelectionValue(model) === value);
              if (next !== undefined) {
                setModelSelection({
                  providerName: next.providerName,
                  modelId: next.modelId,
                });
              }
            }}
          />
        ) : null
      }
    />
  );

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card">
      <div ref={viewportRef} className="relative flex flex-1 flex-col overflow-y-auto">
        <div
          ref={contentRef}
          className={cn(
            "mx-auto flex w-full max-w-3xl flex-1 flex-col gap-y-6 px-4 pt-8 pb-4",
            docked ? "mb-14" : "justify-center",
          )}
        >
          {runsQuery.error !== null && (
            <ErrorItem title="Could not load this chat" message={runsQuery.error.message} />
          )}
          {loadingRuns && (
            <div className="space-y-3">
              {[1, 2, 3].map((key) => (
                <div key={key} className="h-5 animate-pulse rounded-sm bg-muted/40" />
              ))}
            </div>
          )}
          {isEmpty && !loadingRuns && runsQuery.error === null && (
            <h1 className="animate-in text-center text-2xl font-semibold fade-in slide-in-from-bottom-1 duration-200 motion-reduce:animate-none">
              How can I help you today?
            </h1>
          )}
          {runs.map((run) => (
            <RunBlock key={run.id} run={run} onFacts={handleFacts} />
          ))}
          {pendingDisplay.map((item) => (
            <ChatBubble key={item.id} queued>
              {item.text}
            </ChatBubble>
          ))}
          {!docked && composer}
        </div>
        {docked && (
          <div className="sticky z-10 mx-auto w-full max-w-3xl rounded-md bg-card bottom-5">
            <div className="relative">
              {away && (
                <Button
                  size="icon-sm"
                  aria-label="Jump to latest"
                  onClick={scrollToBottom}
                  className="absolute -top-11 left-1/2 size-8 -translate-x-1/2 rounded-full border bg-card text-muted-foreground shadow-overlay hover:bg-muted"
                >
                  <ArrowDown className="size-4" />
                </Button>
              )}
              {composer}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
