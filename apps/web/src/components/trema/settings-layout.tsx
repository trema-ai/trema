import {
  ArrowLeft,
  Building2,
  LogOut,
  Monitor,
  Settings,
  SlidersHorizontal,
  UserRound,
  UsersRound,
} from "lucide-react";
import type { ReactNode } from "react";
import { Link, NavLink } from "react-router";

import { EmptyState } from "#/components/trema/empty-state.tsx";
import { Button } from "#/components/ui/button.tsx";
import { cn } from "#/lib/utils.ts";
import { useAuthenticatedSession, useViewerRole } from "#/pages/home.tsx";

const personalItems = [
  { label: "Profile", href: "/settings/profile", icon: UserRound },
  { label: "Appearance", href: "/settings/appearance", icon: Monitor },
];

const adminItems = [
  { label: "General", href: "/settings/general", icon: Settings },
  { label: "Members", href: "/settings/members", icon: UsersRound },
  { label: "Scopes", href: "/settings/scopes", icon: SlidersHorizontal },
];

function SettingsMenu({
  label,
  items,
}: {
  label: string;
  items: { label: string; href: string; icon: typeof UserRound }[];
}) {
  return (
    <div>
      <div className="mb-1 px-2 text-chrome font-medium text-muted-foreground">{label}</div>
      <nav className="space-y-1" aria-label={`${label} settings`}>
        {items.map((item) => (
          <NavLink
            key={item.href}
            to={item.href}
            className={({ isActive }) =>
              cn(
                "flex h-8 items-center gap-2 rounded-md px-2 text-chrome hover:bg-muted",
                isActive && "bg-muted font-medium",
              )
            }
          >
            <item.icon className="size-4 text-muted-foreground" aria-hidden="true" />
            {item.label}
          </NavLink>
        ))}
      </nav>
    </div>
  );
}

function SettingsLayout({ children }: { children: ReactNode }) {
  const session = useAuthenticatedSession();
  const role = useViewerRole();
  const canAdminister = role === "owner" || role === "admin";

  return (
    <div className="grid min-h-svh bg-background md:grid-cols-[14rem_minmax(0,1fr)]">
      <aside className="flex flex-col border-b bg-sidebar md:h-svh md:border-r md:border-b-0">
        <div className="flex min-w-0 flex-1 flex-col p-3 md:overflow-y-auto">
          <Button variant="ghost" size="sm" className="mb-5 w-fit" asChild>
            <Link to="/">
              <ArrowLeft />
              Back to app
            </Link>
          </Button>
          <div className="grid gap-5 sm:grid-cols-2 md:grid-cols-1">
            <SettingsMenu label="Personal" items={personalItems} />
            {canAdminister ? <SettingsMenu label="Admin" items={adminItems} /> : null}
          </div>
        </div>
        <div className="border-t p-3">
          <div className="mb-2 flex min-w-0 items-center gap-2 px-2">
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
        </div>
      </aside>
      <div className="min-w-0 md:h-svh md:overflow-y-auto">{children}</div>
    </div>
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
