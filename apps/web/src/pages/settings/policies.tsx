import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, UserRound, UsersRound } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { type ApprovalModeValue, ModeBadge } from "#web/components/trema/mode-badge.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Badge } from "#web/components/ui/badge.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Checkbox } from "#web/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import { Label } from "#web/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { Skeleton } from "#web/components/ui/skeleton.tsx";
import { Switch } from "#web/components/ui/switch.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { scopeDisplayName } from "#web/lib/scopes.ts";
import { cn } from "#web/lib/utils.ts";
import { useAuthenticatedSession } from "#web/pages/home.tsx";

type ScopeKind = "org" | "shared" | "personal";

type Scope = {
  id: string;
  kind: ScopeKind;
  name: string;
  ownerId: string | null;
};

type Role = "owner" | "admin" | "member" | "viewer";

type PolicyRow = {
  id: string;
  scopeId: string;
  connectorKey: string | null;
  maxMode: ApprovalModeValue;
  approverRoles: Role[];
  allowRequesterApproval: boolean;
};

type RoutingSource =
  | { kind: "default"; scopeKind: ScopeKind }
  | { kind: "policy"; policyId: string };

type Routing = {
  approverRoles: Role[];
  allowRequesterApproval: boolean;
  source: RoutingSource;
};

type ResolvedPolicies = {
  scopeId: string;
  scopeChain: string[];
  rows: PolicyRow[];
  ceiling: ApprovalModeValue;
  routing: Routing;
};

type Provider = { key: string; displayName: string };

/** What the editor is pointed at: the scope-wide row, or one connector's row. */
type Editor = {
  connectorKey: string | null;
  pickConnector: boolean;
  mode: ApprovalModeValue;
  approverRoles: Role[];
  allowRequesterApproval: boolean;
};

const modes: ApprovalModeValue[] = ["ask", "delegated", "full"];

const allRoles: Role[] = ["owner", "admin", "member", "viewer"];

// Mirrors the server: a scope with no applicable row gets `delegated`, and
// `full` exists only where a row grants it.
const defaultCeiling: ApprovalModeValue = "delegated";

const modeLabels: Record<ApprovalModeValue, string> = {
  ask: "Ask for approval",
  delegated: "Approve for me",
  full: "Full access",
};

const modeDescriptions: Record<ApprovalModeValue, string> = {
  ask: "Every call waits for someone to approve it.",
  delegated: "Calls run on their own; anything that looks risky waits for approval.",
  full: "Calls run without asking anyone.",
};

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

function formatRoles(roles: Role[]) {
  if (roles.length === 0) return "";
  if (roles.length === 1) return roles[0] as string;
  if (roles.length === 2) return `${roles[0]} or ${roles[1]}`;
  return `${roles.slice(0, -1).join(", ")}, or ${roles.at(-1)}`;
}

function routingSentence(roles: Role[], allowRequesterApproval: boolean) {
  if (roles.length === 0) {
    return "Only the person who asked can approve their own calls.";
  }
  const requester = allowRequesterApproval
    ? "People can also approve their own requests."
    : "People cannot approve their own requests.";
  return `Any ${formatRoles(roles)} can approve. ${requester}`;
}

/** The scope-wide rows across the chain — the ones a connector-free view reads. */
function scopeWideRows(data: ResolvedPolicies) {
  return data.rows.filter(
    (row) => row.connectorKey === null && data.scopeChain.includes(row.scopeId),
  );
}

/**
 * The row the ceiling came from: the most restrictive applicable row, with a
 * tie going to the narrowest scope — the one that actually binds here.
 */
function ceilingRow(data: ResolvedPolicies) {
  const applicable = scopeWideRows(data);
  for (let index = data.scopeChain.length - 1; index >= 0; index -= 1) {
    const row = applicable.find(
      (candidate) =>
        candidate.scopeId === data.scopeChain[index] && candidate.maxMode === data.ceiling,
    );
    if (row) return row;
  }
  return undefined;
}

function sourceLabel(row: PolicyRow | undefined, scope: Scope, scopeNames: Map<string, string>) {
  if (!row) return "From a wider scope";
  if (row.scopeId === scope.id) return "Set here";
  return `From ${scopeNames.get(row.scopeId) ?? "a wider scope"}`;
}

function ceilingSourceLabel(data: ResolvedPolicies, scope: Scope, scopeNames: Map<string, string>) {
  const row = ceilingRow(data);
  // A row in a scope the viewer cannot read is filtered out of `rows` but still
  // counted in `ceiling`, so an unattributable ceiling reads as inherited.
  if (!row) {
    return scopeWideRows(data).length === 0 && data.ceiling === defaultCeiling
      ? "Default"
      : "From a wider scope";
  }
  return sourceLabel(row, scope, scopeNames);
}

function routingSourceLabel(data: ResolvedPolicies, scope: Scope, scopeNames: Map<string, string>) {
  if (data.routing.source.kind === "default") return "Default";
  const policyId = data.routing.source.policyId;
  return sourceLabel(
    data.rows.find((row) => row.id === policyId),
    scope,
    scopeNames,
  );
}

function scopeIcon(kind: ScopeKind) {
  if (kind === "org") return Building2;
  if (kind === "personal") return UserRound;
  return UsersRound;
}

function policiesQueryKey() {
  return orpc.policies.key();
}

function SettingsPoliciesPage() {
  const session = useAuthenticatedSession();
  const viewerPrincipalId = session.membership.principal.id;
  const [searchParams, setSearchParams] = useSearchParams();
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const scopeParam = searchParams.get("scope");

  // Org admins cannot read another member's personal scope, so only the org
  // scope, the shared scopes, and the viewer's own personal scope are offered.
  const selectable = useMemo(() => {
    const all = (scopes.data ?? []) as Scope[];
    return [
      ...all.filter((scope) => scope.kind === "org"),
      ...all
        .filter((scope) => scope.kind === "shared")
        .sort((left, right) => left.name.localeCompare(right.name)),
      ...all.filter((scope) => scope.kind === "personal" && scope.ownerId === viewerPrincipalId),
    ];
  }, [scopes.data, viewerPrincipalId]);

  const scopeNames = useMemo(
    () => new Map(selectable.map((scope) => [scope.id, scopeDisplayName(scope)])),
    [selectable],
  );
  const selectedScope =
    selectable.find((scope) => scope.id === scopeParam) ??
    selectable.find((scope) => scope.kind === "org") ??
    selectable[0];

  useEffect(() => {
    if (!selectedScope || scopeParam === selectedScope.id) return;
    setSearchParams(
      (current) => {
        const next = new URLSearchParams(current);
        next.set("scope", selectedScope.id);
        return next;
      },
      { replace: true },
    );
  }, [scopeParam, selectedScope, setSearchParams]);

  function selectScope(scope: Scope) {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set("scope", scope.id);
      return next;
    });
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Policies"
        description="How freely the agent can act in each scope, and who approves the calls that wait."
      />

      {scopes.error ? (
        <Alert variant="destructive">
          <AlertDescription>{scopes.error.message}</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[15rem_minmax(0,1fr)]">
          <aside className="self-start overflow-hidden rounded-md border bg-card p-2">
            {scopes.isPending ? (
              <div className="space-y-2 p-1">
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
                <Skeleton className="h-8 w-full" />
              </div>
            ) : (
              <nav aria-label="Scopes">
                {selectable.map((scope) => (
                  <ScopeRow
                    key={scope.id}
                    scope={scope}
                    selected={scope.id === selectedScope?.id}
                    onSelect={selectScope}
                  />
                ))}
              </nav>
            )}
          </aside>

          {scopes.isPending ? (
            <PolicySkeleton />
          ) : selectedScope ? (
            // Keyed by scope so a scope change (including browser back with the
            // editor open) resets every bit of pane state; a stale editor must
            // never save into the newly selected scope.
            <ScopePolicy key={selectedScope.id} scope={selectedScope} scopeNames={scopeNames} />
          ) : (
            <Alert variant="destructive">
              <AlertDescription>No scope was found to show a policy for.</AlertDescription>
            </Alert>
          )}
        </div>
      )}
    </main>
  );
}

function ScopeRow({
  scope,
  selected,
  onSelect,
}: {
  scope: Scope;
  selected: boolean;
  onSelect: (scope: Scope) => void;
}) {
  const Icon = scopeIcon(scope.kind);
  return (
    <button
      type="button"
      onClick={() => onSelect(scope)}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex h-9 w-full min-w-0 items-center gap-2 rounded-md px-2 text-left text-chrome focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected ? "bg-muted font-medium" : "hover:bg-muted/60",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{scopeDisplayName(scope)}</span>
    </button>
  );
}

function ScopePolicy({ scope, scopeNames }: { scope: Scope; scopeNames: Map<string, string> }) {
  const resolved = useQuery(orpc.policies.resolved.queryOptions({ input: { scopeId: scope.id } }));
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const [editor, setEditor] = useState<Editor>();
  const data = resolved.data as ResolvedPolicies | undefined;
  const providers = (catalog.data ?? []) as Provider[];
  const providerNames = new Map(providers.map((provider) => [provider.key, provider.displayName]));

  if (resolved.error) {
    return (
      <Alert variant="destructive">
        <AlertDescription>{resolved.error.message}</AlertDescription>
      </Alert>
    );
  }

  if (resolved.isPending || !data) return <PolicySkeleton />;

  const own = data.rows.filter((row) => row.scopeId === scope.id);
  const scopeWide = own.find((row) => row.connectorKey === null);
  const connectorRows = own
    .filter((row) => row.connectorKey !== null)
    .sort((left, right) =>
      (providerNames.get(left.connectorKey ?? "") ?? left.connectorKey ?? "").localeCompare(
        providerNames.get(right.connectorKey ?? "") ?? right.connectorKey ?? "",
      ),
    );
  const taken = new Set(connectorRows.map((row) => row.connectorKey));

  // Arrow consts, not declarations: a hoisted function would lose the
  // narrowing that proved `data` is loaded.
  const editScopeWide = () => {
    setEditor(
      scopeWide
        ? {
            connectorKey: null,
            pickConnector: false,
            mode: scopeWide.maxMode,
            approverRoles: scopeWide.approverRoles,
            allowRequesterApproval: scopeWide.allowRequesterApproval,
          }
        : {
            connectorKey: null,
            pickConnector: false,
            mode: data.ceiling,
            approverRoles: data.routing.approverRoles,
            allowRequesterApproval: data.routing.allowRequesterApproval,
          },
    );
  };

  const editConnector = (row: PolicyRow) => {
    setEditor({
      connectorKey: row.connectorKey,
      pickConnector: false,
      mode: row.maxMode,
      approverRoles: row.approverRoles,
      allowRequesterApproval: row.allowRequesterApproval,
    });
  };

  const addConnector = () => {
    setEditor({
      connectorKey: null,
      pickConnector: true,
      mode: data.ceiling,
      approverRoles: data.routing.approverRoles,
      allowRequesterApproval: data.routing.allowRequesterApproval,
    });
  };

  return (
    <section className="min-w-0 space-y-6">
      <section data-slot="settings-section">
        <h3 className="text-chrome font-medium text-foreground">
          What applies in {scopeDisplayName(scope)}
        </h3>
        <p className="mt-0.5 text-meta text-muted-foreground">
          When rules overlap, the strictest one wins.
        </p>
        <div className="mt-2 divide-y rounded-md border bg-card">
          <div className="px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-chrome font-medium">Most access allowed</span>
              <ModeBadge mode={data.ceiling} />
              <Badge variant="outline" className="text-meta font-normal text-muted-foreground">
                {ceilingSourceLabel(data, scope, scopeNames)}
              </Badge>
            </div>
            <p className="mt-1 text-meta text-muted-foreground">
              {modeDescriptions[data.ceiling]}
              {data.ceiling === "delegated"
                ? " Until a classifier model is set up, every call waits instead."
                : ""}
            </p>
          </div>
          <div className="px-4 py-3.5">
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-chrome font-medium">Who can approve</span>
              <Badge variant="outline" className="text-meta font-normal text-muted-foreground">
                {routingSourceLabel(data, scope, scopeNames)}
              </Badge>
            </div>
            <p className="mt-1 text-meta text-muted-foreground">
              {routingSentence(data.routing.approverRoles, data.routing.allowRequesterApproval)}
            </p>
          </div>
        </div>
        <p className="mt-2 text-meta text-muted-foreground">
          Changes apply to new conversations. Anything already running keeps the rules it started
          with.
        </p>
      </section>

      <section data-slot="settings-section">
        <div className="flex items-end justify-between gap-4">
          <div className="min-w-0">
            <h3 className="text-chrome font-medium text-foreground">Connector rules</h3>
          </div>
          <Button variant="outline" size="sm" onClick={addConnector}>
            Add connector rule
          </Button>
        </div>

        {catalog.error ? (
          <Alert variant="destructive" className="mt-2">
            <AlertDescription>{catalog.error.message}</AlertDescription>
          </Alert>
        ) : null}

        <div className="mt-2 divide-y rounded-md border bg-card">
          <RuleRow
            scope={scope}
            title="All connectors"
            mode={scopeWide?.maxMode ?? data.ceiling}
            badge={scopeWide ? undefined : ceilingSourceLabel(data, scope, scopeNames)}
            summary={
              scopeWide
                ? routingSentence(scopeWide.approverRoles, scopeWide.allowRequesterApproval)
                : "No rule set here yet; this is what the scope inherits."
            }
            stored={scopeWide !== undefined}
            connectorKey={null}
            onEdit={editScopeWide}
          />
          {connectorRows.map((row) => (
            <RuleRow
              key={row.id}
              scope={scope}
              title={providerNames.get(row.connectorKey ?? "") ?? (row.connectorKey as string)}
              mode={row.maxMode}
              note={
                providerNames.has(row.connectorKey ?? "") || catalog.isPending
                  ? undefined
                  : "This connector is not in the catalog, so its calls always wait for approval, whatever this rule says."
              }
              summary={routingSentence(row.approverRoles, row.allowRequesterApproval)}
              stored
              connectorKey={row.connectorKey}
              onEdit={() => editConnector(row)}
            />
          ))}
        </div>
      </section>

      {editor ? (
        <PolicyDialog
          key={`${scope.id}:${editor.pickConnector ? "new" : (editor.connectorKey ?? "scope")}`}
          scope={scope}
          editor={editor}
          providers={providers.filter((provider) => !taken.has(provider.key))}
          onClose={() => setEditor(undefined)}
        />
      ) : null}
    </section>
  );
}

function RuleRow({
  scope,
  title,
  mode,
  badge,
  note,
  summary,
  stored,
  connectorKey,
  onEdit,
}: {
  scope: Scope;
  title: string;
  mode: ApprovalModeValue;
  badge?: string | undefined;
  note?: string | undefined;
  summary: string;
  stored: boolean;
  connectorKey: string | null;
  onEdit: () => void;
}) {
  const queryClient = useQueryClient();
  const remove = useMutation({
    mutationFn: () =>
      rpcClient.policies.delete({
        scopeId: scope.id,
        ...(connectorKey === null ? {} : { connectorKey }),
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: policiesQueryKey() });
      toast.success("Rule removed");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  return (
    <div className="flex items-start justify-between gap-6 px-4 py-3.5">
      <div className="min-w-0">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-chrome font-medium">{title}</span>
          <ModeBadge mode={mode} />
          {badge ? (
            <Badge variant="outline" className="text-meta font-normal text-muted-foreground">
              {badge}
            </Badge>
          ) : null}
        </div>
        <p className="mt-1 text-meta text-muted-foreground">{summary}</p>
        {note ? <p className="mt-1 text-meta text-muted-foreground">{note}</p> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {stored ? (
          <Button
            variant="ghost"
            size="sm"
            disabled={remove.isPending}
            onClick={() => remove.mutate()}
          >
            {remove.isPending ? "Removing…" : "Remove"}
          </Button>
        ) : null}
        <Button variant="outline" size="sm" onClick={onEdit}>
          Edit
        </Button>
      </div>
    </div>
  );
}

function PolicyDialog({
  scope,
  editor,
  providers,
  onClose,
}: {
  scope: Scope;
  editor: Editor;
  providers: Provider[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [connectorKey, setConnectorKey] = useState(editor.connectorKey);
  const [mode, setMode] = useState<ApprovalModeValue>(editor.mode);
  const [approverRoles, setApproverRoles] = useState<Role[]>(editor.approverRoles);
  const [allowRequesterApproval, setAllowRequesterApproval] = useState(
    editor.allowRequesterApproval,
  );

  // The one rule the server enforces, checked here so a rule nobody could
  // resolve never leaves the browser.
  const validation =
    approverRoles.length === 0 && !allowRequesterApproval
      ? "Someone must be able to approve: pick at least one role, or let people approve their own requests."
      : editor.pickConnector && connectorKey === null
        ? "Choose a connector for this rule."
        : undefined;

  const save = useMutation({
    mutationFn: () =>
      rpcClient.policies.set({
        scopeId: scope.id,
        ...(connectorKey === null ? {} : { connectorKey }),
        maxMode: mode,
        approverRoles,
        allowRequesterApproval,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: policiesQueryKey() });
      toast.success("Rule saved");
      onClose();
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  function toggleRole(role: Role, checked: boolean) {
    setApproverRoles((current) =>
      checked ? [...current, role] : current.filter((value) => value !== role),
    );
  }

  return (
    <Dialog
      open
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{editor.pickConnector ? "Add connector rule" : "Edit rule"}</DialogTitle>
          <DialogDescription>
            How freely the agent can act in {scopeDisplayName(scope)}, and who approves the calls
            that wait.
          </DialogDescription>
        </DialogHeader>

        {editor.pickConnector ? (
          <div className="space-y-2">
            <Label htmlFor="policy-connector">Connector</Label>
            <Select
              value={connectorKey ?? ""}
              onValueChange={(value) => setConnectorKey(value)}
              disabled={providers.length === 0}
            >
              <SelectTrigger id="policy-connector" className="w-full">
                <SelectValue placeholder="Choose a connector" />
              </SelectTrigger>
              <SelectContent>
                {providers.map((provider) => (
                  <SelectItem key={provider.key} value={provider.key}>
                    {provider.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <p className="text-meta text-muted-foreground">
              Calls from connectors outside the vetted catalog always wait for approval, whatever
              this rule says.
            </p>
          </div>
        ) : null}

        <div className="space-y-2">
          <Label htmlFor="policy-mode">Most access allowed</Label>
          <Select value={mode} onValueChange={(value) => setMode(value as ApprovalModeValue)}>
            <SelectTrigger id="policy-mode" className="w-full">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {modes.map((value) => (
                <SelectItem key={value} value={value}>
                  {modeLabels[value]}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          <p className="text-meta text-muted-foreground">{modeDescriptions[mode]}</p>
          {mode === "delegated" ? (
            <p className="text-meta text-muted-foreground">
              Until a classifier model is set up, every call waits instead.
            </p>
          ) : null}
          {mode === "full" ? (
            <p className="text-meta text-muted-foreground">
              No one reviews these calls before they run; only the audit log records them.
            </p>
          ) : null}
        </div>

        <fieldset className="space-y-2">
          <legend className="text-chrome font-medium">Who can approve</legend>
          <p className="text-meta text-muted-foreground">
            People with these roles in this scope can approve calls that wait.
          </p>
          <div className="grid grid-cols-2 gap-2 pt-1">
            {allRoles.map((role) => (
              <div key={role} className="flex items-center gap-2">
                <Checkbox
                  id={`approver-${role}`}
                  checked={approverRoles.includes(role)}
                  onCheckedChange={(checked) => toggleRole(role, checked === true)}
                />
                <Label htmlFor={`approver-${role}`} className="capitalize">
                  {role}
                </Label>
              </div>
            ))}
          </div>
        </fieldset>

        <div className="flex items-start justify-between gap-6">
          <div className="min-w-0">
            <Label htmlFor="requester-approval" className="text-chrome">
              People can approve their own requests
            </Label>
            <p className="mt-0.5 text-meta text-muted-foreground">
              Whoever asked the agent to do something can approve it themselves. On for new rules.
            </p>
          </div>
          <Switch
            id="requester-approval"
            checked={allowRequesterApproval}
            onCheckedChange={setAllowRequesterApproval}
          />
        </div>

        {validation ? <p className="text-meta text-destructive">{validation}</p> : null}

        <DialogFooter>
          <DialogClose asChild>
            <Button type="button" variant="outline">
              Cancel
            </Button>
          </DialogClose>
          <Button
            type="button"
            disabled={save.isPending || validation !== undefined}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function PolicySkeleton() {
  return (
    <div className="min-w-0 space-y-3">
      <div>
        <Skeleton className="h-4 w-48" />
        <Skeleton className="mt-2 h-3 w-72" />
        <div className="mt-2 divide-y rounded-md border bg-card">
          {["ceiling", "routing"].map((row) => (
            <div key={row} className="space-y-2 px-4 py-3.5">
              <Skeleton className="h-4 w-56" />
              <Skeleton className="h-3 w-80" />
            </div>
          ))}
        </div>
      </div>
      <div className="pt-3">
        <Skeleton className="h-4 w-40" />
        <div className="mt-2 divide-y rounded-md border bg-card">
          {["scope-wide", "connector"].map((row) => (
            <div key={row} className="space-y-2 px-4 py-3.5">
              <Skeleton className="h-4 w-48" />
              <Skeleton className="h-3 w-72" />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

export { SettingsPoliciesPage };
