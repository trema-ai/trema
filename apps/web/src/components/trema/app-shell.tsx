import { Brain, MessageSquarePlus, Settings, Zap } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { AppSidebar, type ThreadSummary } from "#web/components/trema/app-sidebar.tsx";
import { TopBar } from "#web/components/trema/top-bar.tsx";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "#web/components/ui/command.tsx";
import { SidebarInset, SidebarProvider } from "#web/components/ui/sidebar.tsx";

type AppShellProps = {
  children: ReactNode;
  sidebar: Omit<ComponentProps<typeof AppSidebar>, "onSearch" | "threads">;
  orgName: string;
  threads?: ThreadSummary[];
};

const destinations = [
  { label: "New chat", href: "/", icon: MessageSquarePlus },
  { label: "Automations", href: "/automations", icon: Zap },
  { label: "Context", href: "/context", icon: Brain },
  { label: "Settings", href: "/settings", icon: Settings },
];

function AppShell({ children, sidebar, orgName, threads = [] }: AppShellProps) {
  const [searchOpen, setSearchOpen] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    function openSearch(event: KeyboardEvent) {
      if (event.key.toLowerCase() === "k" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        setSearchOpen(true);
      }
    }

    window.addEventListener("keydown", openSearch);
    return () => window.removeEventListener("keydown", openSearch);
  }, []);

  function goTo(href: string) {
    setSearchOpen(false);
    navigate(href);
  }

  return (
    <SidebarProvider>
      <AppSidebar {...sidebar} threads={threads} onSearch={() => setSearchOpen(true)} />
      <SidebarInset className="h-svh overflow-hidden">
        <TopBar orgName={orgName} />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search Trema"
        description="Go to a page or recent session."
      >
        <CommandInput placeholder="Search pages and sessions" />
        <CommandList>
          <CommandEmpty>No results</CommandEmpty>
          <CommandGroup heading="Go to">
            {destinations.map((destination) => (
              <CommandItem
                key={destination.href}
                value={destination.label}
                onSelect={() => goTo(destination.href)}
              >
                <destination.icon />
                {destination.label}
              </CommandItem>
            ))}
          </CommandGroup>
          <CommandSeparator />
          <CommandGroup heading="Recent chats">
            {threads.length === 0 ? (
              <CommandItem disabled value="No chats yet">
                No chats yet
              </CommandItem>
            ) : (
              threads.map((thread) => (
                <CommandItem
                  key={thread.threadRef}
                  // The ref keeps values unique when two chats share a title;
                  // matching still runs on the visible words.
                  value={`${thread.title} ${thread.threadRef}`}
                  onSelect={() => goTo(`/chat/${thread.threadRef}`)}
                >
                  <span className="truncate">{thread.title}</span>
                </CommandItem>
              ))
            )}
          </CommandGroup>
        </CommandList>
      </CommandDialog>
    </SidebarProvider>
  );
}

export { AppShell };
