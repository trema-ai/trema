import {
  ArrowLeft,
  Boxes,
  Building2,
  Cable,
  Inbox,
  LogOut,
  Monitor,
  ScrollText,
  Settings,
  Sparkles,
  ShieldCheck,
  SlidersHorizontal,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, useLocation } from "react-router";

import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarInset,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  SidebarProvider,
  SidebarTrigger,
  useSidebar,
} from "#web/components/ui/sidebar.tsx";
import { useAuthenticatedSession, useViewerRole } from "#web/pages/home.tsx";

const personalItems = [
  { label: "Profile", href: "/settings/profile", icon: UserRound },
  { label: "Appearance", href: "/settings/appearance", icon: Monitor },
];

const adminItems = [
  { label: "General", href: "/settings/general", icon: Settings },
  { label: "Members", href: "/settings/members", icon: UsersRound },
  { label: "Scopes", href: "/settings/scopes", icon: SlidersHorizontal },
  { label: "Connectors", href: "/settings/connectors", icon: Cable },
  { label: "Capabilities", href: "/settings/capabilities", icon: Sparkles },
  { label: "Policies", href: "/settings/policies", icon: ShieldCheck },
  { label: "Approvals", href: "/settings/approvals", icon: Inbox },
  { label: "Models", href: "/settings/models", icon: Boxes },
  { label: "Audit log", href: "/settings/audit", icon: ScrollText },
];

function SettingsMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; href: string; icon: typeof UserRound }[];
}) {
  const location = useLocation();
  // Route changes reconcile this layout in place, so the mobile drawer must
  // close itself when a destination is picked.
  const { setOpenMobile } = useSidebar();
  return (
    <SidebarGroup>
      <SidebarGroupLabel>{label}</SidebarGroupLabel>
      <SidebarGroupContent>
        <SidebarMenu aria-label={`${label} settings`}>
          {items.map((item) => (
            <SidebarMenuItem key={item.href}>
              <SidebarMenuButton
                asChild
                isActive={
                  location.pathname === item.href || location.pathname.startsWith(`${item.href}/`)
                }
              >
                <Link
                  to={item.href}
                  className="text-(length:--text-chrome)"
                  onClick={() => setOpenMobile(false)}
                >
                  <item.icon />
                  <span>{item.label}</span>
                </Link>
              </SidebarMenuButton>
            </SidebarMenuItem>
          ))}
        </SidebarMenu>
      </SidebarGroupContent>
    </SidebarGroup>
  );
}

function SettingsLayout({ children }: { children: ReactNode }) {
  const session = useAuthenticatedSession();
  const role = useViewerRole();
  const canAdminister = role === "owner" || role === "admin";

  return (
    <SidebarProvider>
      <Sidebar>
        <SidebarHeader>
          <Button variant="ghost" size="sm" className="w-fit" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to app
            </Link>
          </Button>
        </SidebarHeader>
        <SidebarContent>
          <SettingsMenu label="Personal" items={personalItems} />
          {canAdminister ? <SettingsMenu label="Admin" items={adminItems} /> : null}
        </SidebarContent>
        <SidebarFooter>
          <div className="flex min-w-0 items-center gap-2 px-2 pt-1">
            <Building2 className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
            <div className="min-w-0">
              <p className="truncate text-chrome font-medium">{session.membership.org.name}</p>
              <p className="truncate text-meta text-muted-foreground">{session.user.email}</p>
            </div>
          </div>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="w-full justify-start"
            onClick={() => void session.signOut()}
          >
            <LogOut />
            Log out
          </Button>
        </SidebarFooter>
      </Sidebar>
      <SidebarInset className="h-svh overflow-hidden">
        <header className="flex h-12 shrink-0 items-center gap-2 border-b bg-background px-4 md:hidden">
          <SidebarTrigger className="-ml-1" />
          <span className="text-chrome font-medium">Settings</span>
        </header>
        <div className="min-h-0 flex-1 overflow-y-auto">{children}</div>
      </SidebarInset>
    </SidebarProvider>
  );
}

function AdminSettingsPage({ children }: { children: ReactNode }) {
  const role = useViewerRole();
  if (role !== "owner" && role !== "admin") {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          title="You don't have access"
          description="This page is limited to organization admins."
        />
      </main>
    );
  }
  return children;
}

export { AdminSettingsPage, SettingsLayout };
