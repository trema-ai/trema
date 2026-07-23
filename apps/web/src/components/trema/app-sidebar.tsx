import {
  BookOpen,
  Check,
  ChevronsUpDown,
  LogOut,
  MessageSquarePlus,
  Search,
  Settings,
  SlidersHorizontal,
  UserRound,
  Zap,
} from "lucide-react";
import { Link, useLocation } from "react-router";
import { Avatar, AvatarFallback } from "#/components/ui/avatar.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
} from "#/components/ui/sidebar.tsx";

type Organization = { id: string; name: string };
type SessionSummary = { id: string; title: string };

const navItems = [
  { label: "New session", icon: MessageSquarePlus, href: "/" },
  { label: "Search", icon: Search },
  { label: "Automations", icon: Zap, href: "/automations" },
  { label: "Customize", icon: SlidersHorizontal, href: "/customize" },
] as const;

export type AppSidebarProps = {
  organizations: Organization[];
  activeOrgId: string;
  name: string;
  email: string;
  role: string;
  sessions?: SessionSummary[];
  onSearch: () => void;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
};

export function AppSidebar({ sessions = [], ...props }: AppSidebarProps) {
  const location = useLocation();
  const active =
    props.organizations.find((org) => org.id === props.activeOrgId) ?? props.organizations[0];
  return (
    <Sidebar>
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" aria-label="Switch organization">
                  <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                    {active?.name.slice(0, 1).toUpperCase()}
                  </div>
                  <span className="min-w-0 flex-1 truncate text-(length:--text-chrome) font-medium">
                    {active?.name}
                  </span>
                  <ChevronsUpDown className="text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" className="w-56">
                {props.organizations.map((org) => (
                  <DropdownMenuItem key={org.id} onSelect={() => props.onSwitch(org.id)}>
                    <span className="flex-1">{org.name}</span>
                    {org.id === props.activeOrgId && <Check className="size-4" />}
                  </DropdownMenuItem>
                ))}
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <SidebarGroup>
          <SidebarGroupContent>
            <SidebarMenu>
              {navItems.map((item) => (
                <SidebarMenuItem key={item.label}>
                  {"href" in item ? (
                    <SidebarMenuButton asChild isActive={location.pathname === item.href}>
                      <Link to={item.href} className="text-(length:--text-chrome)">
                        <item.icon />
                        <span>{item.label}</span>
                      </Link>
                    </SidebarMenuButton>
                  ) : (
                    <SidebarMenuButton
                      type="button"
                      onClick={props.onSearch}
                      className="text-(length:--text-chrome)"
                    >
                      <item.icon />
                      <span>{item.label}</span>
                    </SidebarMenuButton>
                  )}
                </SidebarMenuItem>
              ))}
            </SidebarMenu>
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup>
          <SidebarGroupLabel>Recents</SidebarGroupLabel>
          <SidebarGroupContent>
            {sessions.length === 0 ? (
              <p className="px-2 py-1.5 text-meta text-muted-foreground">No sessions yet</p>
            ) : (
              <SidebarMenu>
                {sessions.map((session) => (
                  <SidebarMenuItem key={session.id}>
                    <SidebarMenuButton asChild>
                      <Link
                        to={`/sessions/${session.id}`}
                        className="text-(length:--text-chrome)"
                        title={session.title}
                      >
                        <span className="truncate">{session.title}</span>
                      </Link>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            )}
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>
      <SidebarFooter>
        <SidebarMenu>
          <SidebarMenuItem>
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <SidebarMenuButton size="lg" aria-label="Open user menu">
                  <Avatar>
                    <AvatarFallback>{props.name.slice(0, 1).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="flex min-w-0 flex-1 flex-col">
                    <span className="truncate text-(length:--text-chrome) font-medium">
                      {props.name}
                    </span>
                    <span className="truncate text-meta text-muted-foreground">{props.email}</span>
                  </span>
                  <ChevronsUpDown className="text-muted-foreground" />
                </SidebarMenuButton>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start" side="top" className="w-56">
                <div className="px-2 py-1.5">
                  <p className="truncate text-chrome font-medium">{props.name}</p>
                  <p className="truncate text-meta text-muted-foreground">{props.email}</p>
                </div>
                <DropdownMenuSeparator />
                <DropdownMenuItem asChild>
                  <Link to="/settings/profile">
                    <UserRound />
                    Profile
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <Link to="/settings">
                    <Settings />
                    Settings
                  </Link>
                </DropdownMenuItem>
                <DropdownMenuItem asChild>
                  <a href="https://trema.so/docs" target="_blank" rel="noreferrer">
                    <BookOpen />
                    Docs
                  </a>
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem onSelect={props.onSignOut}>
                  <LogOut />
                  Log out
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarFooter>
    </Sidebar>
  );
}

export type { SessionSummary };
