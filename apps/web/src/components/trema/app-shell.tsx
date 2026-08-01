import { Brain, ScrollText, Settings, Zap } from "lucide-react";
import { type ComponentProps, type ReactNode, useEffect, useState } from "react";
import { useNavigate } from "react-router";

import { AppSidebar } from "#web/components/trema/app-sidebar.tsx";
import { TopBar } from "#web/components/trema/top-bar.tsx";
import {
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "#web/components/ui/command.tsx";
import { SidebarInset, SidebarProvider } from "#web/components/ui/sidebar.tsx";

type AppShellProps = {
  children: ReactNode;
  sidebar: Omit<ComponentProps<typeof AppSidebar>, "onSearch">;
  orgName: string;
};

const destinations = [
  { label: "Runs", href: "/runs", icon: ScrollText },
  { label: "Automations", href: "/automations", icon: Zap },
  { label: "Context", href: "/customize", icon: Brain },
  { label: "Settings", href: "/settings", icon: Settings },
];

function AppShell({ children, sidebar, orgName }: AppShellProps) {
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
      <AppSidebar {...sidebar} onSearch={() => setSearchOpen(true)} />
      <SidebarInset className="h-svh overflow-hidden">
        <TopBar orgName={orgName} onSearch={() => setSearchOpen(true)} />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
      <CommandDialog
        open={searchOpen}
        onOpenChange={setSearchOpen}
        title="Search Trema"
        description="Go to a console page."
      >
        <CommandInput placeholder="Search pages" />
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
        </CommandList>
      </CommandDialog>
    </SidebarProvider>
  );
}

export { AppShell };
