import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Archive, ChevronRight, RotateCcw } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { KeyValueList } from "#/components/trema/key-value-list.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
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
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "#/components/ui/sheet.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { cn } from "#/lib/utils.ts";
import {
  bodyContent,
  type InstructionBody,
  type Item,
  type ItemVersion,
  type MemoryBody,
  messageFrom,
  type VersionAuthor,
} from "#/pages/customize-types.ts";
import { useAuthenticatedSession } from "#/pages/home.tsx";
import { VersionDiffViewer } from "#/pages/version-diff.tsx";

const memoryTypes = ["fact", "preference", "rule", "procedure"] as const;

function useInvalidateItems() {
  const queryClient = useQueryClient();
  return () =>
    queryClient.invalidateQueries({
      queryKey: orpc.items.list.queryOptions({ input: {} }).queryKey,
    });
}

export function ItemEditorSheet({
  item,
  open,
  onOpenChange,
}: {
  item: Item | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      {item ? <ItemEditorSheetContent key={`${item.id}:${item.version}`} item={item} /> : null}
    </Sheet>
  );
}

function ItemEditorSheetContent({ item }: { item: Item }) {
  const session = useAuthenticatedSession();
  const invalidate = useInvalidateItems();
  const queryClient = useQueryClient();
  const memory = item.body as MemoryBody;
  const [memoryType, setMemoryType] = useState<MemoryBody["type"]>(memory.type);
  const [error, setError] = useState<string>();
  const update = useMutation({
    mutationFn: (input: { title: string; content: string }) =>
      rpcClient.items.update({
        id: item.id,
        title: input.title,
        body: { type: memoryType, content: input.content },
      }),
    onSuccess: async () => {
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({
          queryKey: orpc.items.versions.queryOptions({ input: { id: item.id } }).queryKey,
        }),
      ]);
      toast.success("Memory saved");
    },
  });

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await update.mutateAsync({
        title: String(data.get("title")),
        content: String(data.get("content")),
      });
    } catch (cause) {
      setError(messageFrom(cause));
    }
  }

  const creator = item.sourceSessionId
    ? "Proposed by the agent"
    : item.createdById === session.membership.principal.id
      ? session.membership.principal.displayName
      : item.createdById;

  return (
    <SheetContent className="overflow-y-auto sm:max-w-xl">
      <SheetHeader className="border-b">
        <SheetTitle>Edit memory</SheetTitle>
        <SheetDescription>Edit the memory and review its lifecycle and history.</SheetDescription>
      </SheetHeader>
      <form onSubmit={submit} className="space-y-4 px-4">
        <div className="space-y-2">
          <Label htmlFor={`edit-${item.id}-title`}>Title</Label>
          <Input id={`edit-${item.id}-title`} name="title" defaultValue={item.title} required />
        </div>
        <div className="space-y-2">
          <Label htmlFor={`edit-${item.id}-type`}>Type</Label>
          <Select
            value={memoryType}
            onValueChange={(value) => setMemoryType(value as MemoryBody["type"])}
          >
            <SelectTrigger id={`edit-${item.id}-type`} className="w-full capitalize">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {memoryTypes.map((type) => (
                <SelectItem key={type} value={type} className="capitalize">
                  {type}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-2">
          <Label htmlFor={`edit-${item.id}-content`}>Content</Label>
          <Textarea
            id={`edit-${item.id}-content`}
            name="content"
            defaultValue={memory.content}
            rows={9}
            required
          />
        </div>
        {error ? <p className="text-meta text-destructive">{error}</p> : null}
        <Button type="submit" disabled={update.isPending}>
          {update.isPending ? "Saving…" : "Save changes"}
        </Button>
      </form>

      <section className="space-y-3 border-t px-4 pt-4">
        <h3 className="text-chrome font-medium">Metadata</h3>
        <KeyValueList
          items={[
            { label: "Status", value: <span className="capitalize">{item.status}</span> },
            {
              label: "Used",
              value: item.disclosure === "standing" ? "In every session" : "When relevant",
            },
            { label: "Version", value: item.version },
            { label: "Created", value: <RelativeTime date={item.createdAt} /> },
            { label: "Updated", value: <RelativeTime date={item.updatedAt} /> },
            {
              label: "Last used",
              value: item.lastUsedAt ? <RelativeTime date={item.lastUsedAt} /> : "Never",
            },
            {
              label: "Created by",
              value: creator,
              mono: !item.sourceSessionId && item.createdById !== session.membership.principal.id,
            },
          ]}
        />
      </section>

      <section className="space-y-3 border-t px-4 pt-4">
        <h3 className="text-chrome font-medium">Version history</h3>
        <ItemVersionHistory item={item} />
      </section>

      <SheetFooter className="border-t">
        <LifecycleActions item={item} />
      </SheetFooter>
    </SheetContent>
  );
}

export function ItemVersionHistory({ item }: { item: Item }) {
  const session = useAuthenticatedSession();
  const invalidate = useInvalidateItems();
  const queryClient = useQueryClient();
  const [expanded, setExpanded] = useState<number | null>(item.version);
  const versions = useQuery(orpc.items.versions.queryOptions({ input: { id: item.id } }));
  const restore = useMutation({
    mutationFn: (version: ItemVersion) =>
      rpcClient.items.update({
        id: item.id,
        title: version.title,
        body: version.body as MemoryBody | InstructionBody,
      }),
    onSuccess: async (_result, version) => {
      await Promise.all([
        invalidate(),
        queryClient.invalidateQueries({
          queryKey: orpc.items.versions.queryOptions({ input: { id: item.id } }).queryKey,
        }),
      ]);
      toast.success(`Version ${version.version} restored as a new version`);
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  if (versions.isPending) return <Skeleton className="h-16 w-full" />;
  if (versions.error) {
    return <p className="text-meta text-destructive">{versions.error.message}</p>;
  }

  const priors = (versions.data as ItemVersion[])
    .slice()
    .sort((left, right) => left.version - right.version);
  if (priors.length === 0) {
    return <p className="text-meta text-muted-foreground">No prior versions.</p>;
  }
  // The server resolves authors for prior versions; the current row's author is
  // resolved locally from ids the client already knows.
  const knownAuthors = new Map(
    priors.flatMap((version) => (version.author ? [[version.author.id, version.author]] : [])),
  );
  const currentAuthor: VersionAuthor | null = item.updatedById
    ? item.updatedById === session.membership.principal.id
      ? {
          id: item.updatedById,
          displayName: session.membership.principal.displayName,
          kind: "human",
        }
      : (knownAuthors.get(item.updatedById) ?? {
          id: item.updatedById,
          displayName: "Agent",
          kind: "agent",
        })
    : null;
  const chain: ItemVersion[] = [
    ...priors,
    {
      version: item.version,
      title: item.title,
      body: item.body,
      author: currentAuthor,
      createdAt: item.updatedAt,
    },
  ];
  const entries = chain
    .map((version, index) => ({
      version,
      previous: index > 0 ? chain[index - 1] : undefined,
      isCurrent: index === chain.length - 1,
    }))
    .reverse();

  return (
    <ul className="divide-y rounded-md border bg-card">
      {entries.map(({ version, previous, isCurrent }) => {
        const open = expanded === version.version;
        const delta = previous
          ? bodyContent(version.body).length - bodyContent(previous.body).length
          : bodyContent(version.body).length;
        const summary = previous
          ? delta === 0
            ? "Details changed"
            : `${delta > 0 ? "+" : "−"}${Math.abs(delta).toLocaleString()} characters`
          : `${delta.toLocaleString()} characters`;
        return (
          <li key={version.version} className="space-y-2 px-3 py-2.5">
            <div className="flex items-center gap-2">
              <button
                type="button"
                aria-expanded={open}
                onClick={() => setExpanded(open ? null : version.version)}
                className="flex min-w-0 flex-1 items-center gap-2 rounded-md text-left focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <ChevronRight
                  className={cn(
                    "size-4 shrink-0 text-muted-foreground transition-transform",
                    open && "rotate-90",
                  )}
                  aria-hidden="true"
                />
                <span className="whitespace-nowrap text-chrome font-medium">
                  Version {version.version}
                </span>
                {isCurrent ? (
                  <span className="text-meta text-muted-foreground">Current</span>
                ) : null}
                {!open ? (
                  <span className="truncate text-meta text-muted-foreground">{summary}</span>
                ) : null}
              </button>
              <span className="inline-flex shrink-0 gap-x-2 text-meta text-muted-foreground">
                {version.author ? (
                  <span className="truncate">
                    {version.author.kind === "agent" ? "the agent" : version.author.displayName} ·
                  </span>
                ) : null}
                <RelativeTime date={version.createdAt} />
              </span>
              {!isCurrent ? (
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={restore.isPending}
                  onClick={() => restore.mutate(version)}
                >
                  <RotateCcw />
                  Restore
                </Button>
              ) : null}
            </div>
            {open ? (
              previous ? (
                <VersionDiff before={previous} after={version} />
              ) : (
                <p className="whitespace-pre-wrap text-meta text-muted-foreground">
                  {bodyContent(version.body)}
                </p>
              )
            ) : null}
          </li>
        );
      })}
    </ul>
  );
}

function VersionDiff({ before, after }: { before: ItemVersion; after: ItemVersion }) {
  const beforeContent = bodyContent(before.body);
  const afterContent = bodyContent(after.body);
  if (beforeContent === afterContent) {
    return (
      <p className="text-meta text-muted-foreground">
        {before.title === after.title ? "No content change" : `Renamed from "${before.title}"`}
      </p>
    );
  }
  return <VersionDiffViewer before={beforeContent} after={afterContent} />;
}

export function LifecycleActions({ item, compact = false }: { item: Item; compact?: boolean }) {
  const invalidate = useInvalidateItems();
  const action = useMutation({
    mutationFn: (kind: "activate" | "restore") =>
      kind === "activate"
        ? rpcClient.items.activate({ id: item.id })
        : rpcClient.items.restore({ id: item.id }),
    onSuccess: async (_result, kind) => {
      await invalidate();
      toast.success(kind === "activate" ? "Item activated" : "Item restored");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  if (item.status === "proposed") {
    return (
      <Button
        size={compact ? "sm" : "default"}
        disabled={action.isPending}
        onClick={() => action.mutate("activate")}
      >
        Activate
      </Button>
    );
  }
  if (item.status === "archived") {
    return (
      <Button
        size={compact ? "sm" : "default"}
        disabled={action.isPending}
        onClick={() => action.mutate("restore")}
      >
        <RotateCcw />
        Restore
      </Button>
    );
  }
  return <ArchiveItemButton item={item} compact={compact} />;
}

export function ArchiveItemButton({
  item,
  compact = false,
  label = "Archive",
  description,
}: {
  item: Item;
  compact?: boolean;
  label?: string;
  description?: string;
}) {
  const invalidate = useInvalidateItems();
  const archive = useMutation({
    mutationFn: () => rpcClient.items.archive({ id: item.id }),
    onSuccess: async () => {
      await invalidate();
      toast.success("Item archived");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });
  return (
    <AlertDialog>
      <AlertDialogTrigger asChild>
        <Button variant="destructive" size={compact ? "sm" : "default"}>
          <Archive />
          {label}
        </Button>
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {label} {item.title}?
          </AlertDialogTitle>
          <AlertDialogDescription>
            {description ?? "This item will stop affecting sessions. You can restore it later."}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction
            variant="destructive"
            disabled={archive.isPending}
            onClick={() => archive.mutate()}
          >
            {archive.isPending ? "Archiving…" : label}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
