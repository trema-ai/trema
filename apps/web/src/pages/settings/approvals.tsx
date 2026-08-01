import { keepPreviousData, useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { CircleCheck, CircleX, Clock, Inbox, type LucideIcon } from "lucide-react";
import { useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { ApprovalCard } from "#web/components/trema/approval-card.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import type { ApprovalModeValue } from "#web/components/trema/mode-badge.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Skeleton } from "#web/components/ui/skeleton.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#web/components/ui/tabs.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { scopeDisplayName } from "#web/lib/scopes.ts";

// The server's page size and its hard cap; the list has no cursor beyond that.
const PAGE_SIZE = 50;
const MAX_LIMIT = 200;

type Status = "pending" | "approved" | "denied" | "expired";

type Approval = {
  id: string;
  sessionId: string;
  scopeId: string;
  toolKey: string;
  args: unknown;
  reason: string;
  mode: ApprovalModeValue;
  escalationReason: string | null;
  requesterPrincipalId: string | null;
  status: Status;
  expiresAt: string;
  resolvedById: string | null;
  resolvedAt: string | null;
  createdAt: string;
  connectorAccount: {
    label: string;
    source: "personal" | "organization";
  } | null;
};

type Member = { principal: { id: string; displayName: string } };

type Scope = { id: string; kind: "org" | "shared" | "personal"; name: string };

const statusTabs: { value: Status; label: string }[] = [
  { value: "pending", label: "Pending" },
  { value: "approved", label: "Approved" },
  { value: "denied", label: "Denied" },
  { value: "expired", label: "Expired" },
];

const emptyStates: Record<Status, { icon: LucideIcon; title: string; description: string }> = {
  pending: {
    icon: Inbox,
    title: "Nothing waiting",
    description: "Approvals appear here when a gated call waits on you.",
  },
  approved: {
    icon: CircleCheck,
    title: "Nothing approved",
    description: "Calls that were let through appear here.",
  },
  denied: {
    icon: CircleX,
    title: "Nothing denied",
    description: "Calls that were refused appear here.",
  },
  expired: {
    icon: Clock,
    title: "Nothing expired",
    description: "An approval nobody answers within 24 hours ends up here.",
  },
};

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function isStatus(value: string | null): value is Status {
  return statusTabs.some((tab) => tab.value === value);
}

/* Turn a key segment such as `issues.create` into readable prose. */
function humanize(segment: string) {
  const words = segment.replace(/[_.\-/]+/g, " ").trim();
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/*
 * Tool keys read `provider:tool`, so the card can name the call and where it
 * runs separately. Item activation is an approval like any other, but it is
 * the control plane asking, not a connector.
 */
function describeCall(toolKey: string) {
  if (toolKey === "context:activate_item") {
    return {
      headline: "Activate a proposed item",
      toolTitle: "Activate item",
      connector: "Context",
    };
  }
  const separator = toolKey.indexOf(":");
  if (separator === -1) {
    return { headline: `Run ${toolKey}`, toolTitle: humanize(toolKey), connector: toolKey };
  }
  const toolTitle = humanize(toolKey.slice(separator + 1));
  const connector = humanize(toolKey.slice(0, separator));
  return { headline: `${toolTitle} in ${connector}`, toolTitle, connector };
}

/*
 * Approve and deny answer with different shapes; the page only needs to know
 * whether approving also activated an item.
 */
async function resolveApproval({
  id,
  option,
}: {
  id: string;
  option: string;
}): Promise<{ activatedItemId: string | undefined }> {
  if (option !== "approve") {
    await rpcClient.approvals.deny({ id });
    return { activatedItemId: undefined };
  }
  const { activatedItemId } = await rpcClient.approvals.approve({ id });
  return { activatedItemId };
}

function summarizeArgs(args: unknown) {
  if (args === undefined || args === null) return "{}";
  try {
    return JSON.stringify(args) ?? String(args);
  } catch {
    return String(args);
  }
}

export function SettingsApprovalsPage() {
  const queryClient = useQueryClient();
  const [searchParams, setSearchParams] = useSearchParams();
  // In-flight resolutions by approval id, so one card's mutation neither
  // blocks nor mislabels another's.
  const [resolving, setResolving] = useState<Record<string, string>>({});
  const [limit, setLimit] = useState(PAGE_SIZE);
  const statusParam = searchParams.get("status");
  const status: Status = isStatus(statusParam) ? statusParam : "pending";

  const approvals = useQuery(
    orpc.approvals.list.queryOptions({
      input: { status, limit },
      // Someone else may answer first, so the pending list keeps itself honest.
      refetchInterval: status === "pending" ? 30_000 : false,
      // Growing the limit re-keys the query; keep the list up while it loads.
      placeholderData: keepPreviousData,
    }),
  );
  const members = useQuery(orpc.members.list.queryOptions({}));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));

  const memberNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const member of (members.data ?? []) as Member[]) {
      names.set(member.principal.id, member.principal.displayName);
    }
    return names;
  }, [members.data]);

  const scopeNames = useMemo(() => {
    const names = new Map<string, string>();
    for (const scope of (scopes.data ?? []) as Scope[]) {
      names.set(scope.id, scopeDisplayName(scope));
    }
    return names;
  }, [scopes.data]);

  const resolve = useMutation({
    mutationFn: resolveApproval,
    onSuccess: async (result, variables) => {
      await queryClient.invalidateQueries({ queryKey: orpc.approvals.list.key() });
      if (variables.option !== "approve") {
        toast.success("Denied");
        return;
      }
      toast.success(result.activatedItemId ? "Approved, and the item is now active" : "Approved");
    },
    // A late answer gets a conflict; refetching clears the card it was aimed at.
    onError: async (cause) => {
      toast.error(messageFrom(cause));
      await queryClient.invalidateQueries({ queryKey: orpc.approvals.list.key() });
    },
    onSettled: (_data, _error, variables) =>
      setResolving((current) => {
        const { [variables.id]: _settled, ...rest } = current;
        return rest;
      }),
  });

  function selectStatus(next: string) {
    setLimit(PAGE_SIZE);
    setSearchParams(
      (current) => {
        const params = new URLSearchParams(current);
        params.set("status", next);
        return params;
      },
      { replace: true },
    );
  }

  function handleResolve(id: string, option: string) {
    if (resolving[id] !== undefined) return;
    setResolving((current) => ({ ...current, [id]: option }));
    resolve.mutate({ id, option });
  }

  const rows = ((approvals.data?.approvals ?? []) as Approval[]).filter(
    (approval) => approval.status === status,
  );
  const empty = emptyStates[status];
  // After a tab switch the kept data belongs to the previous status: its rows
  // fail the filter, which must read as loading, never as an empty tab.
  const stalePlaceholder = approvals.isPlaceholderData && rows.length === 0;
  // A full page means there may be more; the server offers no cursor past its cap.
  const maybeMore =
    !approvals.isPlaceholderData && (approvals.data?.approvals.length ?? 0) >= limit;

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Approvals"
        description="Agent tool calls waiting on a person. The list shows the approvals you may resolve."
      />
      <Tabs value={status} onValueChange={selectStatus}>
        <TabsList className="mb-3">
          {statusTabs.map((tab) => (
            <TabsTrigger key={tab.value} value={tab.value}>
              {tab.label}
            </TabsTrigger>
          ))}
        </TabsList>
        <TabsContent value={status}>
          {approvals.error ? (
            <Alert variant="destructive">
              <AlertDescription>{approvals.error.message}</AlertDescription>
            </Alert>
          ) : approvals.isPending || stalePlaceholder ? (
            <div className="space-y-4">
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
              <Skeleton className="h-44 w-full" />
            </div>
          ) : rows.length === 0 ? (
            <div className="rounded-md border bg-card">
              <EmptyState icon={empty.icon} title={empty.title} description={empty.description} />
            </div>
          ) : (
            <div className="space-y-4">
              {rows.map((approval) => (
                <ApprovalRow
                  key={approval.id}
                  approval={approval}
                  memberNames={memberNames}
                  scopeNames={scopeNames}
                  resolving={resolving[approval.id]}
                  onResolve={handleResolve}
                />
              ))}
              {maybeMore ? (
                limit < MAX_LIMIT ? (
                  <div className="flex justify-center">
                    <Button
                      variant="outline"
                      size="sm"
                      disabled={approvals.isFetching}
                      onClick={() =>
                        setLimit((current) => Math.min(current + PAGE_SIZE, MAX_LIMIT))
                      }
                    >
                      {approvals.isFetching ? "Loading…" : "Show more"}
                    </Button>
                  </div>
                ) : (
                  <p className="text-center text-meta text-muted-foreground">
                    Only the first {MAX_LIMIT} approvals are shown.
                  </p>
                )
              ) : null}
            </div>
          )}
        </TabsContent>
      </Tabs>
    </main>
  );
}

function ApprovalRow({
  approval,
  memberNames,
  scopeNames,
  resolving,
  onResolve,
}: {
  approval: Approval;
  memberNames: Map<string, string>;
  scopeNames: Map<string, string>;
  /* The option currently being sent for this approval, when one is in flight. */
  resolving: string | undefined;
  onResolve: (id: string, option: string) => void;
}) {
  const call = describeCall(approval.toolKey);
  // A null requester is an unlinked one: the surface user has no identity link,
  // so the session recorded a raw surface id instead of a principal.
  const requester =
    approval.requesterPrincipalId === null
      ? "an unlinked requester"
      : (memberNames.get(approval.requesterPrincipalId) ?? "unknown");
  const scopeName = scopeNames.get(approval.scopeId);
  const resolver =
    approval.resolvedById === null
      ? undefined
      : (memberNames.get(approval.resolvedById) ?? "unknown");
  const pending = approval.status === "pending";

  return (
    <ApprovalCard
      headline={call.headline}
      kind="approval"
      action={{
        toolTitle: call.toolTitle,
        connector: call.connector,
        mode: approval.mode,
        // Only a delegated-mode call carries one, and only when the classifier escalated.
        ...(approval.escalationReason === null
          ? {}
          : { escalationReason: approval.escalationReason }),
        argsSummary: summarizeArgs(approval.args),
      }}
      {...(approval.connectorAccount === null
        ? {}
        : {
            connector: {
              name: call.connector,
              account: approval.connectorAccount,
            },
          })}
      prompt={approval.reason}
      requestedBy={scopeName ? `${requester} in ${scopeName}` : requester}
      options={
        pending
          ? [
              {
                id: "approve",
                label: resolving === "approve" ? "Approving…" : "Approve",
                variant: "primary",
              },
              {
                id: "deny",
                label: resolving === "deny" ? "Denying…" : "Deny",
                variant: "destructive",
              },
            ]
          : []
      }
      {...(pending
        ? { expiresAt: approval.expiresAt, onResolve: (option) => onResolve(approval.id, option) }
        : {
            resolution: {
              outcome: approval.status,
              ...(resolver === undefined ? {} : { by: resolver }),
              ...(approval.resolvedAt === null ? {} : { at: approval.resolvedAt }),
            },
          })}
    />
  );
}
