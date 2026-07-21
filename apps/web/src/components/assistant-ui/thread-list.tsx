import { ThreadListItemPrimitive, ThreadListPrimitive } from "@assistant-ui/react";
import { Archive, Plus } from "lucide-react";

/* One row in the chat history. The archive action fades in on hover. */
function ThreadListItem() {
  return (
    <ThreadListItemPrimitive.Root
      data-slot="thread-list-item"
      className="group/thread-item flex items-center rounded-md text-chrome text-sidebar-foreground hover:bg-sidebar-accent data-[active]:bg-sidebar-accent"
    >
      <ThreadListItemPrimitive.Trigger className="min-w-0 flex-1 truncate px-2 py-1.5 text-left">
        <ThreadListItemPrimitive.Title fallback="New chat" />
      </ThreadListItemPrimitive.Trigger>
      <ThreadListItemPrimitive.Archive
        aria-label="Archive chat"
        className="mr-1 flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground opacity-0 transition-opacity duration-150 group-hover/thread-item:opacity-100 hover:text-sidebar-accent-foreground focus-visible:opacity-100"
      >
        <Archive className="size-3.5" />
      </ThreadListItemPrimitive.Archive>
    </ThreadListItemPrimitive.Root>
  );
}

/* Sidebar chat history: a "New chat" action followed by the thread rows. */
function ThreadList() {
  return (
    <ThreadListPrimitive.Root data-slot="thread-list" className="flex flex-col gap-0.5">
      <ThreadListPrimitive.New asChild>
        <button
          type="button"
          className="flex items-center gap-2 rounded-md px-2 py-1.5 text-left text-chrome text-sidebar-foreground hover:bg-sidebar-accent"
        >
          <Plus className="size-4 text-muted-foreground" />
          New chat
        </button>
      </ThreadListPrimitive.New>
      <ThreadListPrimitive.Items components={{ ThreadListItem }} />
    </ThreadListPrimitive.Root>
  );
}

export { ThreadList };
