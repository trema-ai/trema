import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, MoreHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";

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
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "#/components/ui/collapsible.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "#/components/ui/sheet.tsx";
import { Skeleton } from "#/components/ui/skeleton.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { ItemVersionHistory } from "#/pages/customize-item-editor.tsx";
import {
  type InstructionBody,
  type Item,
  messageFrom,
  type Scope,
} from "#/pages/customize-types.ts";

export function InstructionsTab({
  items,
  scope,
  orgScope,
  loading,
}: {
  items: Item[];
  scope: Scope;
  orgScope: Scope | undefined;
  loading: boolean;
}) {
  const activeScopeItems = items.filter(
    (item) => item.kind === "instruction" && item.status === "active" && item.scopeId === scope.id,
  );
  const instruction = activeScopeItems[activeScopeItems.length - 1];
  const orgInstructions =
    orgScope && orgScope.id !== scope.id
      ? items.filter(
          (item) =>
            item.kind === "instruction" && item.status === "active" && item.scopeId === orgScope.id,
        )
      : [];

  if (loading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-11 w-full" />
        <Skeleton className="h-80 w-full" />
      </div>
    );
  }

  const orgContent = orgInstructions
    .map((item) => (item.body as InstructionBody).content)
    .join("\n\n");

  return (
    <div className="space-y-4">
      {orgScope && orgInstructions.length > 0 ? (
        <OrgContext name={orgScope.name} content={orgContent} />
      ) : null}
      {activeScopeItems.length > 1 ? (
        <p className="text-meta text-muted-foreground">
          This scope has {activeScopeItems.length} active instructions; sessions receive all of
          them. Editing here changes the newest.
        </p>
      ) : null}
      <InstructionEditor
        key={`${scope.id}:${instruction?.id ?? "new"}:${instruction?.version ?? 0}`}
        scope={scope}
        orgName={orgScope?.name ?? scope.name}
        item={instruction}
      />
    </div>
  );
}

function OrgContext({ name, content }: { name: string; content: string }) {
  const lineCount = content.split("\n").length;

  return (
    <Collapsible className="group rounded-md border bg-card">
      <CollapsibleTrigger className="flex w-full items-center gap-2 px-4 py-3 text-left">
        <ChevronRight
          className="size-4 shrink-0 text-muted-foreground transition-transform group-data-[state=open]:rotate-90"
          aria-hidden="true"
        />
        <span className="min-w-0 truncate text-chrome font-medium">Org Instructions</span>
        <span className="ml-auto shrink-0 text-meta text-muted-foreground">
          {lineCount.toLocaleString()} {lineCount === 1 ? "line" : "lines"}
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <p className="whitespace-pre-wrap border-t px-4 py-3 text-chrome text-muted-foreground">
          {content}
        </p>
      </CollapsibleContent>
    </Collapsible>
  );
}

function InstructionEditor({
  scope,
  orgName,
  item,
}: {
  scope: Scope;
  orgName: string;
  item: Item | undefined;
}) {
  const queryClient = useQueryClient();
  const persistedContent = item ? (item.body as InstructionBody).content : "";
  const [content, setContent] = useState(persistedContent);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [archiveOpen, setArchiveOpen] = useState(false);
  const dirty = content !== persistedContent;
  const invalid = content.trim().length === 0;

  const save = useMutation({
    mutationFn: (nextContent: string) =>
      item
        ? rpcClient.items.update({
            id: item.id,
            body: { content: nextContent },
          })
        : rpcClient.items.create({
            scopeId: scope.id,
            kind: "instruction",
            title: "Instructions",
            body: { content: nextContent },
          }),
    onSuccess: async () => {
      await Promise.all([
        invalidateItems(queryClient),
        item
          ? queryClient.invalidateQueries({
              queryKey: orpc.items.versions.queryOptions({ input: { id: item.id } }).queryKey,
            })
          : Promise.resolve(),
      ]);
      toast.success("Instructions saved");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  const archive = useMutation({
    mutationFn: () => {
      if (!item) throw new Error("No active instructions to archive");
      return rpcClient.items.archive({ id: item.id });
    },
    onSuccess: async () => {
      await invalidateItems(queryClient);
      toast.success("Instructions archived");
    },
    onError: (cause) => toast.error(messageFrom(cause)),
  });

  const title =
    scope.kind === "org" ? `Instructions for ${orgName}` : `Instructions for ${scope.name}`;
  const description =
    scope.kind === "org"
      ? "Added to every session in the organization."
      : `Added to every session in this scope, after ${orgName}'s instructions.`;

  return (
    <>
      <section className="overflow-hidden rounded-md border bg-card">
        <header className="flex items-start gap-4 px-4 py-3">
          <div className="min-w-0">
            <h2 className="text-chrome font-medium">{title}</h2>
            <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
          </div>
          {item ? (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  className="ml-auto"
                  aria-label="Instruction actions"
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem variant="destructive" onSelect={() => setArchiveOpen(true)}>
                  Archive
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          ) : null}
        </header>

        <div className="px-4 pb-4">
          <Textarea
            value={content}
            onChange={(event) => setContent(event.currentTarget.value)}
            rows={10}
            className="resize-y"
            placeholder="Write standing guidance for the agent…"
            aria-label={title}
          />
        </div>

        <footer className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t px-4 py-3 text-meta text-muted-foreground">
          <span>{content.length.toLocaleString()} characters</span>
          {item ? (
            <>
              <span>
                Edited <RelativeTime date={item.updatedAt} />
              </span>
              <Button
                type="button"
                variant="link"
                size="sm"
                className="h-auto p-0 text-meta"
                onClick={() => setHistoryOpen(true)}
              >
                History
              </Button>
            </>
          ) : null}
          <div className="ml-auto flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={!dirty || save.isPending}
              onClick={() => setContent(persistedContent)}
            >
              Discard
            </Button>
            <Button
              type="button"
              size="sm"
              disabled={!dirty || invalid || save.isPending}
              onClick={() => save.mutate(content)}
            >
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </footer>
      </section>

      {item ? (
        <>
          <Sheet open={historyOpen} onOpenChange={setHistoryOpen}>
            <SheetContent className="overflow-y-auto sm:max-w-xl">
              <SheetHeader className="border-b">
                <SheetTitle>Instruction history</SheetTitle>
              </SheetHeader>
              <div className="px-4">
                <ItemVersionHistory item={item} />
              </div>
            </SheetContent>
          </Sheet>
          <AlertDialog open={archiveOpen} onOpenChange={setArchiveOpen}>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive instructions?</AlertDialogTitle>
                <AlertDialogDescription>
                  Sessions will stop receiving these instructions. You can restore them later.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction
                  variant="destructive"
                  disabled={archive.isPending}
                  onClick={() => archive.mutate()}
                >
                  {archive.isPending ? "Archiving…" : "Archive"}
                </AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      ) : null}
    </>
  );
}

function invalidateItems(queryClient: ReturnType<typeof useQueryClient>) {
  return queryClient.invalidateQueries({
    queryKey: orpc.items.list.queryOptions({ input: {} }).queryKey,
  });
}
