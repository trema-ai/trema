import { useMutation } from "@tanstack/react-query";
import { Loader2Icon, RotateCcw, Square, ThumbsDown, ThumbsUp } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { Button } from "#web/components/ui/button.tsx";
import { rpcClient } from "#web/lib/api.ts";

/**
 * The write side of the run view. Every control submits one intent and lets
 * the log answer: the pressed control acknowledges immediately (a spinner,
 * the group disabled) but its outcome renders only when the corresponding
 * event arrives on the tail — `elicitation-resolved` for a decision, the
 * cancelled terminal for a stop — never optimistically (interface 03's
 * lying-UI rule). Feedback is the one exception: it is an audit fact with no
 * log event, so `recorded` acknowledges from the response.
 */

type SubmitIntentInput = Parameters<typeof rpcClient.intents.submit>[0];

/** Submits one intent under a freshly minted id. */
function submitIntent(intent: SubmitIntentInput["intent"]) {
  return rpcClient.intents.submit({ intentId: crypto.randomUUID(), intent });
}

/** The structured code the intent endpoint attaches to a refusal, if any. */
function intentErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const data = (error as { data?: unknown }).data;
  if (typeof data !== "object" || data === null) return undefined;
  const code = (data as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * The resolve wiring for a live elicitation card. `pendingOptionId` holds the
 * pressed option from the click until the resolution event lands on the tail
 * and swaps the card for its history row — a 2xx does not clear it, because
 * the log, not the response, is the acknowledgement. An `elicitation_resolved`
 * conflict means someone else decided first: the event is already on its way,
 * so the card reconciles to the resolved rendering instead of showing failure.
 */
export function useResolveElicitation(elicitationId: string): {
  resolve: (optionId: string) => void;
  pendingOptionId: string | undefined;
  error: string | undefined;
} {
  const [pendingOptionId, setPendingOptionId] = useState<string>();
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (optionId: string) => submitIntent({ type: "resolve", elicitationId, optionId }),
    onMutate: (optionId: string) => {
      setPendingOptionId(optionId);
      setError(undefined);
    },
    onError: (cause) => {
      if (intentErrorCode(cause) === "elicitation_resolved") return;
      setPendingOptionId(undefined);
      setError(messageFrom(cause));
    },
  });
  return { resolve: mutation.mutate, pendingOptionId, error };
}

/**
 * The stop control, colocated with the run's live indication. A recorded stop
 * keeps the pressed state: the acknowledgement is the cancelled terminal
 * arriving on the tail, which ends the live row and this control with it.
 */
export function StopControl({ runId }: { runId: string }) {
  const [stopping, setStopping] = useState(false);
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: () => submitIntent({ type: "stop", runId }),
    onMutate: () => {
      setStopping(true);
      setError(undefined);
    },
    onError: (cause) => {
      // `run_not_active` means the run settled on its own first; the terminal
      // event about to land removes this row, so stay pressed and quiet.
      if (intentErrorCode(cause) === "run_not_active") return;
      setStopping(false);
      setError(messageFrom(cause));
    },
  });
  return (
    <span className="flex items-center gap-2">
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={stopping}
        onClick={() => mutation.mutate()}
      >
        {stopping ? <Loader2Icon className="animate-spin" /> : <Square />}
        {stopping ? "Stopping" : "Stop"}
      </Button>
      {error !== undefined && <span className="text-meta text-destructive">{error}</span>}
    </span>
  );
}

/**
 * The retry control for a failed or stale run. `retried` names the new run;
 * navigating to it is the acknowledgement, since the new run's own log is the
 * truth about what the retry did.
 */
export function RetryControl({ runId }: { runId: string }) {
  const navigate = useNavigate();
  const mutation = useMutation({
    mutationFn: () => submitIntent({ type: "retry", runId }),
    onSuccess: (result) => {
      if (result.runId !== null) void navigate(`/runs/${result.runId}`);
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  return (
    <Button
      type="button"
      variant="outline"
      size="sm"
      disabled={mutation.isPending}
      onClick={() => mutation.mutate()}
    >
      {mutation.isPending ? <Loader2Icon className="animate-spin" /> : <RotateCcw />}
      Retry
    </Button>
  );
}

/**
 * Thumbs on a settled run. Feedback mutates no run and writes no log event,
 * so the response's `recorded` is the acknowledgement, rendered as a quiet
 * line in place of the controls.
 */
export function FeedbackControls({ runId }: { runId: string }) {
  const [recorded, setRecorded] = useState(false);
  const mutation = useMutation({
    mutationFn: (verdict: "up" | "down") => submitIntent({ type: "feedback", runId, verdict }),
    onSuccess: () => setRecorded(true),
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  if (recorded) {
    return <p className="text-meta text-muted-foreground">Feedback recorded.</p>;
  }
  const pendingVerdict = mutation.isPending ? mutation.variables : undefined;
  return (
    <div className="flex items-center gap-1 text-meta text-muted-foreground">
      <span className="mr-1">Rate this run</span>
      {(["up", "down"] as const).map((verdict) => (
        <Button
          key={verdict}
          type="button"
          variant="ghost"
          size="icon-xs"
          aria-label={verdict === "up" ? "Good run" : "Bad run"}
          disabled={mutation.isPending}
          onClick={() => mutation.mutate(verdict)}
        >
          {pendingVerdict === verdict ? (
            <Loader2Icon className="animate-spin" />
          ) : verdict === "up" ? (
            <ThumbsUp />
          ) : (
            <ThumbsDown />
          )}
        </Button>
      ))}
    </div>
  );
}
