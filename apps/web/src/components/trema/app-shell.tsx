import type { ComponentProps, ReactNode } from "react";

import { AppSidebar } from "#/components/trema/app-sidebar.tsx";
import { TopBar } from "#/components/trema/top-bar.tsx";
import { SidebarInset, SidebarProvider } from "#/components/ui/sidebar.tsx";

type AppShellProps = {
  children: ReactNode;
  sidebar: ComponentProps<typeof AppSidebar>;
  orgName: string;
};

/*
 * The app frame: collapsible sidebar on the left, top bar with the
 * breadcrumb, and a content area that scrolls on its own.
 */
function AppShell({ children, sidebar, orgName }: AppShellProps) {
  return (
    <SidebarProvider>
      <AppSidebar {...sidebar} />
      <SidebarInset className="h-svh overflow-hidden">
        <TopBar orgName={orgName} />
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

export { AppShell };
