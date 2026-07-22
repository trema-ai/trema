import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Check,
  ChevronsUpDown,
  Gauge,
  ListTree,
  LogOut,
  MessageSquarePlus,
  Play,
  Plug,
  ScrollText,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  Users,
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
type NavGroup = { label: string; items: { label: string; icon: LucideIcon; href?: string }[] };
const navGroups: NavGroup[] = [
  {
    label: "Chat",
    items: [
      { label: "New chat", icon: MessageSquarePlus },
      { label: "Search", icon: Search },
    ],
  },
  {
    label: "Runs",
    items: [
      { label: "Runs", icon: Play },
      { label: "Approvals", icon: ShieldCheck },
    ],
  },
  {
    label: "Context",
    items: [
      { label: "Memory", icon: Brain },
      { label: "Skills", icon: Sparkles },
      { label: "Instructions", icon: BookOpen },
      { label: "Connectors", icon: Plug },
    ],
  },
  {
    label: "Organization",
    items: [
      { label: "Scopes", icon: ListTree, href: "/scopes" },
      { label: "Members", icon: Users },
      { label: "Policies", icon: Shield },
      { label: "Automations", icon: Zap },
      { label: "Audit", icon: ScrollText },
      { label: "Usage", icon: Gauge },
      { label: "Settings", icon: Settings },
      { label: "Gallery", icon: Sparkles, href: "/gallery" },
    ],
  },
];

export type AppSidebarProps = {
  organizations: Organization[];
  activeOrgId: string;
  name: string;
  email: string;
  role: string;
  onSwitch: (id: string) => void;
  onSignOut: () => void;
};

export function AppSidebar(props: AppSidebarProps) {
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
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton
                      asChild
                      isActive={item.href !== undefined && location.pathname === item.href}
                    >
                      {item.href ? (
                        <Link to={item.href} className="text-(length:--text-chrome)">
                          <item.icon />
                          <span>{item.label}</span>
                        </Link>
                      ) : (
                        <a
                          href={`#${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                          className="text-(length:--text-chrome)"
                        >
                          <item.icon />
                          <span>{item.label}</span>
                        </a>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
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
                <DropdownMenuItem disabled>{props.name}</DropdownMenuItem>
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
