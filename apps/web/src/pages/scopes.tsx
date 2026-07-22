import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Building2, Inbox, Lock, Pencil, Plus, Trash2, UserRound, UsersRound } from "lucide-react";
import { type FormEvent, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router";
import { toast } from "sonner";

import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { IdChip } from "#/components/trema/id-chip.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { ScopeBadge } from "#/components/trema/scope-badge.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";
import { useViewerRole } from "#/pages/home.tsx";

type Scope = {
  id: string;
  kind: "org" | "shared" | "personal";
  name: string;
  ownerId: string | null;
};

type Binding = {
  id: string;
  surface: string;
  locationRef: string;
  scopeId: string;
  createdAt: string;
  updatedAt: string;
};

type Surface = {
  id: string;
  name: string;
  status: "planned" | "available";
};

function messageFrom(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function ScopesPage() {
  const role = useViewerRole();
  const canManage = role === "owner" || role === "admin";
  const [searchParams, setSearchParams] = useSearchParams();
  const [bindingOpen, setBindingOpen] = useState(false);
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const scopeParam = searchParams.get("scope");
  const organized = useMemo(() => {
    const all = (scopes.data ?? []) as Scope[];
    return {
      org: all.find((scope) => scope.kind === "org"),
      sharedScopes: all
        .filter((scope) => scope.kind === "shared")
        .sort((left, right) => left.name.localeCompare(right.name)),
      personalCount: all.filter((scope) => scope.kind === "personal").length,
    };
  }, [scopes.data]);
  const selectable = organized.org
    ? [organized.org, ...organized.sharedScopes]
    : organized.sharedScopes;
  const selectedScope = selectable.find((scope) => scope.id === scopeParam) ?? organized.org;

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
    <main className="mx-auto w-full max-w-7xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Scopes"
        description="Organize shared context and choose where the agent uses it."
        actions={
          canManage && !scopes.isPending && !scopes.error ? (
            <>
              <NewScopeDialog />
              <Button onClick={() => setBindingOpen(true)}>
                <Plus />
                New binding
              </Button>
            </>
          ) : undefined
        }
      />

      {scopes.error ? (
        <Alert variant="destructive">
          <AlertDescription>{scopes.error.message}</AlertDescription>
        </Alert>
      ) : (
        <div className="grid gap-6 lg:grid-cols-[17rem_minmax(0,1fr)]">
          <ScopeTree
            loading={scopes.isPending}
            org={organized.org}
            sharedScopes={organized.sharedScopes}
            personalCount={organized.personalCount}
            selectedId={selectedScope?.id}
            onSelect={selectScope}
          />
          {scopes.isPending ? (
            <DetailSkeleton />
          ) : selectedScope ? (
            <ScopeDetail
              scope={selectedScope}
              canManage={canManage}
              onNewBinding={() => setBindingOpen(true)}
            />
          ) : (
            <Alert variant="destructive">
              <AlertDescription>No organization scope was found.</AlertDescription>
            </Alert>
          )}
        </div>
      )}

      {canManage && selectedScope ? (
        <NewBindingDialog
          open={bindingOpen}
          onOpenChange={setBindingOpen}
          scopes={selectable}
          defaultScopeId={selectedScope.id}
        />
      ) : null}
    </main>
  );
}

function ScopeTree({
  loading,
  org,
  sharedScopes,
  personalCount,
  selectedId,
  onSelect,
}: {
  loading: boolean;
  org: Scope | undefined;
  sharedScopes: Scope[];
  personalCount: number;
  selectedId: string | undefined;
  onSelect: (scope: Scope) => void;
}) {
  return (
    <aside className="self-start overflow-hidden rounded-lg border bg-card">
      <div className="border-b px-4 py-3">
        <h2 className="text-chrome font-medium text-muted-foreground">Scope tree</h2>
      </div>
      <div className="p-2">
        {loading ? (
          <div className="space-y-2 p-2">
            <Skeleton className="h-8 w-full" />
            <Skeleton className="ml-5 h-8 w-[calc(100%-1.25rem)]" />
            <Skeleton className="ml-5 h-8 w-[calc(100%-1.25rem)]" />
            <Skeleton className="h-8 w-full" />
          </div>
        ) : (
          <>
            {org ? (
              <ScopeTreeRow scope={org} selected={org.id === selectedId} onSelect={onSelect} />
            ) : null}
            {sharedScopes.map((sharedScope) => (
              <ScopeTreeRow
                key={sharedScope.id}
                scope={sharedScope}
                selected={sharedScope.id === selectedId}
                onSelect={onSelect}
                nested
              />
            ))}
            <div className="mt-1 flex h-9 items-center gap-2 rounded-md px-2 text-chrome text-muted-foreground">
              <UserRound className="size-4" aria-hidden="true" />
              <span>Personal ({personalCount})</span>
            </div>
          </>
        )}
      </div>
      <div className="flex gap-2 border-t px-4 py-3 text-meta text-muted-foreground">
        <Lock className="mt-0.5 size-3.5 shrink-0" aria-hidden="true" />
        <p>Personal scope content is owner-only. Admins see existence, never content.</p>
      </div>
    </aside>
  );
}

function ScopeTreeRow({
  scope,
  selected,
  onSelect,
  nested = false,
}: {
  scope: Scope;
  selected: boolean;
  onSelect: (scope: Scope) => void;
  nested?: boolean;
}) {
  const Icon = scope.kind === "org" ? Building2 : UsersRound;
  return (
    <button
      type="button"
      onClick={() => onSelect(scope)}
      aria-current={selected ? "page" : undefined}
      className={cn(
        "flex h-9 w-full items-center gap-2 rounded-md px-2 text-left text-chrome hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        nested && "pl-7",
        selected && "bg-moss-soft hover:bg-moss-soft",
      )}
    >
      <Icon className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <span className="truncate">{scope.name}</span>
    </button>
  );
}

function ScopeDetail({
  scope,
  canManage,
  onNewBinding,
}: {
  scope: Scope;
  canManage: boolean;
  onNewBinding: () => void;
}) {
  const bindings = useQuery(orpc.bindings.list.queryOptions({ input: { scopeId: scope.id } }));
  const rows = (bindings.data ?? []) as Binding[];
  const columns: DataTableColumn<Binding>[] = [
    {
      key: "surface",
      header: "Connector",
      render: (binding) => <span className="capitalize">{binding.surface}</span>,
    },
    {
      key: "location",
      header: "Location",
      render: (binding) => <IdChip id={binding.locationRef} visibleChars={24} />,
    },
    {
      key: "created",
      header: "Created",
      render: (binding) => <RelativeTime date={binding.createdAt} />,
    },
    ...(canManage
      ? [
          {
            key: "actions",
            header: <span className="sr-only">Actions</span>,
            width: "3rem",
            align: "right" as const,
            render: (binding: Binding) => (
              <DeleteBindingButton binding={binding} scopeId={scope.id} />
            ),
          },
        ]
      : []),
  ];

  return (
    <section className="min-w-0 space-y-5">
      <div className="flex items-start justify-between gap-4 rounded-lg border bg-card p-4">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <h2 className="truncate text-base font-semibold">{scope.name}</h2>
            <ScopeBadge scope={scope.kind} />
          </div>
          <p className="mt-1 font-mono text-meta text-muted-foreground">{scope.id}</p>
        </div>
        {canManage && scope.kind === "shared" ? <RenameScopeDialog scope={scope} /> : null}
      </div>

      <div className="space-y-3">
        <div>
          <h3 className="text-chrome font-medium text-muted-foreground">Bindings</h3>
          <p className="mt-1 text-meta text-muted-foreground">
            Locations that resolve to this scope.
          </p>
        </div>
        {bindings.error ? (
          <Alert variant="destructive">
            <AlertDescription>{bindings.error.message}</AlertDescription>
          </Alert>
        ) : (
          <DataTable
            columns={columns}
            rows={rows}
            rowKey={(binding) => binding.id}
            loading={bindings.isPending}
            empty={
              <EmptyState
                icon={Inbox}
                title="No bindings yet"
                description="Bindings connect places the agent is reachable — a Slack channel, a Linear team — to this scope."
                action={
                  canManage ? (
                    <Button size="sm" onClick={onNewBinding}>
                      <Plus />
                      New binding
                    </Button>
                  ) : undefined
                }
              />
            }
          />
        )}
      </div>
    </section>
  );
}

function NewScopeDialog() {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (name: string) => rpcClient.scopes.create({ name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: orpc.scopes.list.queryOptions({ input: {} }).queryKey,
      });
      toast.success("Scope created");
      setOpen(false);
    },
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync(String(data.get("name")));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  return (
    <>
      <Button variant="outline" onClick={() => setOpen(true)}>
        <Plus />
        New scope
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
      >
        <DialogContent>
          <form onSubmit={submit} className="contents">
            <DialogHeader>
              <DialogTitle>New scope</DialogTitle>
              <DialogDescription>Create a shared scope under the organization.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor="new-scope-name">Name</Label>
              <Input id="new-scope-name" name="name" autoFocus required />
            </div>
            {error ? <p className="text-meta text-destructive">{error}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Creating…" : "Create scope"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function RenameScopeDialog({ scope }: { scope: Scope }) {
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (name: string) => rpcClient.scopes.rename({ id: scope.id, name }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: orpc.scopes.list.queryOptions({ input: {} }).queryKey,
      });
      toast.success("Scope renamed");
      setOpen(false);
    },
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync(String(data.get("name")));
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  return (
    <>
      <Button
        variant="ghost"
        size="icon-sm"
        aria-label={`Rename ${scope.name}`}
        onClick={() => setOpen(true)}
      >
        <Pencil />
      </Button>
      <Dialog
        open={open}
        onOpenChange={(next) => {
          setOpen(next);
          if (!next) setError(undefined);
        }}
      >
        <DialogContent>
          <form onSubmit={submit} className="contents">
            <DialogHeader>
              <DialogTitle>Rename scope</DialogTitle>
              <DialogDescription>Change the display name for this shared scope.</DialogDescription>
            </DialogHeader>
            <div className="space-y-2">
              <Label htmlFor={`rename-${scope.id}`}>Name</Label>
              <Input
                id={`rename-${scope.id}`}
                name="name"
                defaultValue={scope.name}
                autoFocus
                required
              />
            </div>
            {error ? <p className="text-meta text-destructive">{error}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Saving…" : "Save name"}
              </Button>
            </DialogFooter>
          </form>
        </DialogContent>
      </Dialog>
    </>
  );
}

function NewBindingDialog({
  open,
  onOpenChange,
  scopes,
  defaultScopeId,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  scopes: Scope[];
  defaultScopeId: string;
}) {
  const queryClient = useQueryClient();
  const surfaces = useQuery(orpc.surfaces.list.queryOptions());
  const availableSurfaces = useMemo(
    () => ((surfaces.data ?? []) as Surface[]).filter((surface) => surface.status === "available"),
    [surfaces.data],
  );
  const [surfaceId, setSurfaceId] = useState("");
  const [scopeId, setScopeId] = useState(defaultScopeId);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (open) {
      setScopeId(defaultScopeId);
      setSurfaceId(availableSurfaces[0]?.id ?? "");
    }
  }, [availableSurfaces, defaultScopeId, open]);
  const mutation = useMutation({
    mutationFn: (input: { surface: string; locationRef: string; scopeId: string }) =>
      rpcClient.bindings.create(input),
    onSuccess: async (_binding, input) => {
      await queryClient.invalidateQueries({
        queryKey: orpc.bindings.list.queryOptions({ input: { scopeId: input.scopeId } }).queryKey,
      });
      toast.success("Binding created");
      onOpenChange(false);
    },
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await mutation.mutateAsync({
        surface: surfaceId,
        locationRef: String(data.get("locationRef")),
        scopeId,
      });
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (next) {
          setScopeId(defaultScopeId);
          setSurfaceId(availableSurfaces[0]?.id ?? "");
        }
        if (!next) setError(undefined);
        onOpenChange(next);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>New binding</DialogTitle>
          <DialogDescription>
            Bind a place the agent is reachable — a Slack channel, a Linear team — to a scope.
          </DialogDescription>
        </DialogHeader>
        {surfaces.isPending ? (
          <Skeleton className="h-24 w-full" />
        ) : surfaces.error ? (
          <Alert variant="destructive">
            <AlertDescription>{surfaces.error.message}</AlertDescription>
          </Alert>
        ) : availableSurfaces.length === 0 ? (
          <p className="text-chrome text-muted-foreground">
            Nothing can be bound yet. Locations appear here once a connector that provides them —
            such as Slack — is connected.
          </p>
        ) : (
          <form onSubmit={submit} className="contents">
            <div className="space-y-2">
              <Label htmlFor="binding-surface">Connector</Label>
              <Select value={surfaceId} onValueChange={setSurfaceId} required>
                <SelectTrigger id="binding-surface" className="w-full" autoFocus>
                  <SelectValue placeholder="Select a connector" />
                </SelectTrigger>
                <SelectContent>
                  {availableSurfaces.map((surface) => (
                    <SelectItem key={surface.id} value={surface.id}>
                      {surface.name}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label htmlFor="binding-location">Location ref</Label>
              <Input
                id="binding-location"
                name="locationRef"
                className="font-mono"
                placeholder="workspace:channel"
                required
              />
            </div>
            <div className="space-y-2">
              <Label htmlFor="binding-scope">Scope</Label>
              <Select value={scopeId} onValueChange={setScopeId}>
                <SelectTrigger id="binding-scope" className="w-full">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {scopes.map((scope) => (
                    <SelectItem key={scope.id} value={scope.id}>
                      {scope.name} ({scope.kind})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {error ? <p className="text-meta text-destructive">{error}</p> : null}
            <DialogFooter>
              <DialogClose asChild>
                <Button type="button" variant="outline">
                  Cancel
                </Button>
              </DialogClose>
              <Button type="submit" disabled={mutation.isPending}>
                {mutation.isPending ? "Creating…" : "Create binding"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}

function DeleteBindingButton({ binding, scopeId }: { binding: Binding; scopeId: string }) {
  const queryClient = useQueryClient();
  const mutation = useMutation({
    mutationFn: () => rpcClient.bindings.delete({ id: binding.id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: orpc.bindings.list.queryOptions({ input: { scopeId } }).queryKey,
      });
      toast.success("Binding deleted");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={`Delete binding for ${binding.locationRef}`}
        >
          <Trash2 />
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete binding</AlertDialogTitle>
          <AlertDialogDescription>
            Delete the binding for <span className="font-mono">{binding.locationRef}</span>? New
            activity at this location will no longer resolve to this scope.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={() => mutation.mutate()}>
            Delete binding
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function DetailSkeleton() {
  return (
    <div className="space-y-5">
      <div className="rounded-lg border p-4">
        <Skeleton className="h-5 w-40" />
        <Skeleton className="mt-2 h-3 w-64" />
      </div>
      <div className="space-y-3">
        <Skeleton className="h-3 w-20" />
        <DataTable
          columns={[
            { key: "surface", header: "Connector", render: () => null },
            { key: "location", header: "Location", render: () => null },
            { key: "created", header: "Created", render: () => null },
          ]}
          rows={[]}
          rowKey={() => "loading"}
          loading
        />
      </div>
    </div>
  );
}
