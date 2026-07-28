import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import { useNavigate, useParams } from "react-router";

import { ChatComposer } from "#web/components/trema/chat-composer.tsx";
import { ErrorItem } from "#web/components/trema/error-item.tsx";
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
import { isTerminalRunState, type PrincipalLike } from "#web/lib/run-timeline.ts";
import { ulid } from "#web/lib/ulid.ts";
import { RunBlock, type RunBlockFacts, type ThreadRun } from "#web/pages/chat/run-block.tsx";
import { useAuthenticatedSession, useViewerRole } from "#web/pages/home.tsx";
import { type QueuedInputItem, QueuedInputNote } from "#web/pages/runs/timeline.tsx";

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
interface PendingSend {
  id: string;
  kind: "steering" | "follow_up";
  text: string;
  queuedAt: string;
}

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
    const listed: ThreadRun[] = serverRuns ?? [];
    const known = new Set(listed.map((run) => run.id));
    const extra = (placeholders ?? []).filter((run) => !known.has(run.id));
    return [...listed, ...extra].sort((a, b) =>
      a.createdAt === b.createdAt
        ? a.id.localeCompare(b.id)
        : a.createdAt.localeCompare(b.createdAt),
    );
  }, [serverRuns, placeholders]);

  // A placeholder is provisional: once the thread-runs read lists the run,
  // the server read owns it.
  useEffect(() => {
    if (serverRuns !== undefined && serverRuns.length > 0) {
      prunePlaceholderRuns(
        threadRef,
        serverRuns.map((run) => run.id),
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
  }, [activeRunId, queryClient]);

  // ----- pending input: queuedInput on the run read plus fresh 2xx sends ---
  const activeRunQuery = useQuery(
    orpc.runs.get.queryOptions({
      input: { id: activeRunId ?? "" },
      enabled: activeRunId !== undefined,
    }),
  );
  const queuedInput = useMemo<QueuedInputItem[]>(
    () =>
      activeRunId !== undefined && activeRunQuery.data?.access === "full"
        ? activeRunQuery.data.queuedInput
        : [],
    [activeRunId, activeRunQuery.data],
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

  // A local pending entry ends when a run read newer than it no longer lists
  // the id: the steer drained (its steering event carries it from here on).
  useEffect(() => {
    if (activeRunId === undefined || activeRunQuery.data === undefined) return;
    const readAt = activeRunQuery.dataUpdatedAt;
    const listed = new Set(queuedInput.map((item) => item.id));
    setPendingSends((previous) =>
      previous.filter(
        (entry) =>
          entry.kind !== "steering" || listed.has(entry.id) || Date.parse(entry.queuedAt) > readAt,
      ),
    );
  }, [activeRunId, activeRunQuery.data, activeRunQuery.dataUpdatedAt, queuedInput]);

  // A pending follow-up ends when the run it started appears on the thread.
  useEffect(() => {
    if (serverRuns === undefined) return;
    setPendingSends((previous) =>
      previous.filter(
        (entry) =>
          entry.kind !== "follow_up" ||
          !serverRuns.some(
            (run) => run.createdAt >= entry.queuedAt && run.openingMessage?.text === entry.text,
          ),
      ),
    );
  }, [serverRuns]);

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

  const sendMutation = useMutation({
    mutationFn: (input: { intentId: string; text: string }) =>
      rpcClient.intents.submit({
        intentId: input.intentId,
        threadRef,
        intent: { type: "message", text: input.text },
      }),
  });

  function handleSend() {
    const text = draft.trim();
    if (text === "" || sendMutation.isPending) return;
    const intentId = crypto.randomUUID();
    setDraft("");
    setSendError(undefined);
    sendMutation.mutate(
      { intentId, text },
      {
        onSuccess: (result) => {
          const queuedAt = new Date().toISOString();
          if (result.outcome === "started" && result.runId !== null) {
            // The 2xx certifies a durable run: render it now, from view
            // state, until the thread-runs read lists it.
            recordStartedRun(threadRef, {
              id: result.runId,
              state: "queued",
              trigger: "message",
              createdAt: queuedAt,
              openingMessage: { author, text },
            });
            if (isNew) void navigate(`/chat/${threadRef}`);
          } else if (result.outcome === "steered" || result.outcome === "follow-up") {
            const kind = result.outcome === "steered" ? "steering" : "follow_up";
            setPendingSends((previous) => [...previous, { id: intentId, kind, text, queuedAt }]);
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

  return (
    <div className="flex h-full flex-col overflow-hidden bg-card">
      <div ref={viewportRef} className="relative flex flex-1 flex-col overflow-y-auto">
        <div
          ref={contentRef}
          className="mx-auto flex w-full max-w-[740px] flex-1 flex-col gap-5 px-4 pt-8 pb-4"
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
            <div className="flex flex-1 items-center justify-center">
              <p className="text-chat text-muted-foreground">How can I help?</p>
            </div>
          )}
          {runs.map((run) => (
            <RunBlock key={run.id} run={run} onFacts={handleFacts} />
          ))}
          {pendingDisplay.map((item) => (
            <QueuedInputNote key={item.id} item={item} />
          ))}
        </div>
        <div className="sticky bottom-0 z-10 mx-auto w-full max-w-[740px] bg-card px-4 pb-4">
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
            {personalOff ? (
              <PersonalScopesNotice canManage={role === "owner" || role === "admin"} />
            ) : (
              <ChatComposer
                value={draft}
                onValueChange={setDraft}
                onSend={handleSend}
                onStop={
                  activeRunId === undefined ? undefined : () => stopMutation.mutate(activeRunId)
                }
                stopping={stopping}
                error={sendError}
                autoFocus
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
