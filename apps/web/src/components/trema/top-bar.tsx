import { Search } from "lucide-react";
import { useLocation } from "react-router";

import { ThemeToggle } from "#web/components/trema/theme-toggle.tsx";
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from "#web/components/ui/breadcrumb.tsx";
import { Kbd } from "#web/components/ui/kbd.tsx";
import { Separator } from "#web/components/ui/separator.tsx";
import { SidebarTrigger } from "#web/components/ui/sidebar.tsx";

const pageNames: Record<string, string> = {
  "/": "Runs",
  "/runs": "Runs",
  "/automations": "Automations",
  "/customize": "Context",
  "/scopes": "Scopes",
  "/gallery": "Gallery",
};

/* Slim bar above the content: sidebar toggle, breadcrumb, and actions. */
function TopBar({ orgName, onSearch }: { orgName: string; onSearch: () => void }) {
  const location = useLocation();
  const pageName =
    pageNames[location.pathname] ??
    (location.pathname.startsWith("/settings/") ? "Settings" : "Run");
  return (
    <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="mr-1 data-[orientation=vertical]:h-4" />
      <Breadcrumb>
        <BreadcrumbList className="text-(length:--text-chrome)">
          <BreadcrumbItem>
            <BreadcrumbLink href="/runs">{orgName}</BreadcrumbLink>
          </BreadcrumbItem>
          <BreadcrumbSeparator />
          <BreadcrumbItem>
            <BreadcrumbPage>{pageName}</BreadcrumbPage>
          </BreadcrumbItem>
        </BreadcrumbList>
      </Breadcrumb>
      <div className="ml-auto flex items-center gap-1.5">
        <button
          type="button"
          onClick={onSearch}
          className="flex h-8 items-center gap-2 rounded-md border bg-card px-2.5 text-meta text-muted-foreground hover:bg-muted"
        >
          <Search className="size-3.5" />
          Search
          <Kbd>⌘K</Kbd>
        </button>
        <ThemeToggle />
      </div>
    </header>
  );
}

export { TopBar };
