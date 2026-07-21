import type { LucideIcon } from "lucide-react";
import {
  BookOpen,
  Brain,
  Check,
  ChevronsUpDown,
  Gauge,
  LogOut,
  MessageSquarePlus,
  Palette,
  Play,
  Plug,
  ScrollText,
  Search,
  Settings,
  Shield,
  ShieldCheck,
  Sparkles,
  User,
  Users,
  Zap,
} from "lucide-react";
import { useState } from "react";

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

const scopes = [
  { id: "acme", name: "Acme (org)", initial: "A" },
  { id: "support", name: "Support", initial: "S" },
  { id: "engineering", name: "Engineering", initial: "E" },
  { id: "personal", name: "Personal", initial: "P" },
] as const;

type ScopeId = (typeof scopes)[number]["id"];

type NavItem = {
  label: string;
  icon: LucideIcon;
  active?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
};

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
      { label: "Runs", icon: Play, active: true },
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
      { label: "Members", icon: Users },
      { label: "Policies", icon: Shield },
      { label: "Automations", icon: Zap },
      { label: "Audit", icon: ScrollText },
      { label: "Usage", icon: Gauge },
      { label: "Settings", icon: Settings },
    ],
  },
];

function ScopeSwitcher() {
  const [activeId, setActiveId] = useState<ScopeId>("acme");
  const active = scopes.find((scope) => scope.id === activeId) ?? scopes[0];

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label="Switch scope">
              <div className="flex size-7 shrink-0 items-center justify-center rounded-md bg-primary text-xs font-semibold text-primary-foreground">
                {active.initial}
              </div>
              <span className="min-w-0 flex-1 truncate text-(length:--text-chrome) font-medium">
                {active.name}
              </span>
              <ChevronsUpDown className="text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" className="w-56">
            {scopes.map((scope) => (
              <DropdownMenuItem key={scope.id} onSelect={() => setActiveId(scope.id)}>
                <span className="flex-1">{scope.name}</span>
                {scope.id === activeId && <Check className="size-4" />}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function UserMenu() {
  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton size="lg" aria-label="Open user menu">
              <Avatar size="sm">
                <AvatarFallback>N</AvatarFallback>
              </Avatar>
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="truncate text-(length:--text-chrome) font-medium">Nelson</span>
                <span className="truncate text-meta text-muted-foreground">nelson@acme.dev</span>
              </span>
              <ChevronsUpDown className="text-muted-foreground" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="start" side="top" className="w-56">
            <DropdownMenuItem>
              <User />
              Profile
            </DropdownMenuItem>
            <DropdownMenuItem>
              <Palette />
              Theme
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem>
              <LogOut />
              Log out
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}

function AppSidebar() {
  return (
    <Sidebar>
      <SidebarHeader>
        <ScopeSwitcher />
      </SidebarHeader>
      <SidebarContent>
        {navGroups.map((group) => (
          <SidebarGroup key={group.label}>
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <SidebarMenu>
                {group.items.map((item) => (
                  <SidebarMenuItem key={item.label}>
                    <SidebarMenuButton asChild isActive={item.active ?? false}>
                      <a
                        href={`#${item.label.toLowerCase().replace(/\s+/g, "-")}`}
                        className="text-(length:--text-chrome)"
                      >
                        <item.icon />
                        <span>{item.label}</span>
                      </a>
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                ))}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>
      <SidebarFooter>
        <UserMenu />
      </SidebarFooter>
    </Sidebar>
  );
}

export { AppSidebar };
