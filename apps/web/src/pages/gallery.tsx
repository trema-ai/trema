import { CalendarClock, Inbox, Plus, Search, SettingsIcon, UserIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { toast } from "sonner";

import { ThreadDemo } from "#/components/assistant-ui/thread-demo.tsx";
import { ActivityCard } from "#/components/trema/activity-card.tsx";
import { ApprovalCard } from "#/components/trema/approval-card.tsx";
import { CopyButton } from "#/components/trema/copy-button.tsx";
import { CredentialStatusBadge } from "#/components/trema/credential-status-badge.tsx";
import { DataTable, type DataTableColumn } from "#/components/trema/data-table.tsx";
import { EmptyState } from "#/components/trema/empty-state.tsx";
import { ErrorItem } from "#/components/trema/error-item.tsx";
import { FilterBar, FilterSearch, FilterSelect } from "#/components/trema/filter-bar.tsx";
import { IdChip } from "#/components/trema/id-chip.tsx";
import { KeyValueList } from "#/components/trema/key-value-list.tsx";
import { LogLine } from "#/components/trema/log-line.tsx";
import { OutputViewer } from "#/components/trema/output-viewer.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { ReasoningBlock } from "#/components/trema/reasoning-block.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import { type RunState, RunStateBadge } from "#/components/trema/run-state-badge.tsx";
import { ScopeBadge } from "#/components/trema/scope-badge.tsx";
import { SegmentDivider } from "#/components/trema/segment-divider.tsx";
import { SensitivityBadge } from "#/components/trema/sensitivity-badge.tsx";
import { SettingRow, SettingsSection } from "#/components/trema/settings-section.tsx";
import { StatusDot } from "#/components/trema/status-dot.tsx";
import { SteeringNote } from "#/components/trema/steering-note.tsx";
import { UnknownEventsLine } from "#/components/trema/unknown-events-line.tsx";
import { LogoMark, Wordmark } from "#/components/trema/wordmark.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "#/components/ui/alert-dialog.tsx";
import { Badge } from "#/components/ui/badge.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
  CommandShortcut,
} from "#/components/ui/command.tsx";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "#/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "#/components/ui/dropdown-menu.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { Popover, PopoverContent, PopoverTrigger } from "#/components/ui/popover.tsx";
import { RadioGroup, RadioGroupItem } from "#/components/ui/radio-group.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from "#/components/ui/sheet.tsx";
import { Switch } from "#/components/ui/switch.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#/components/ui/tabs.tsx";
import { Textarea } from "#/components/ui/textarea.tsx";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "#/components/ui/tooltip.tsx";

/* ------------------------------------------------------------------ */
/* Local helpers                                                      */
/* ------------------------------------------------------------------ */

type SectionProps = {
  title: string;
  bare?: boolean;
  children: ReactNode;
};

/* A gallery section heading plus a card area (or open layout). */
function Section({ title, bare = false, children }: SectionProps) {
  return (
    <section className="space-y-3">
      <h2 className="text-chrome font-medium text-muted-foreground">{title}</h2>
      {bare ? children : <div className="rounded-md border bg-card p-6">{children}</div>}
    </section>
  );
}

type VariantProps = {
  label: string;
  children: ReactNode;
};

/* One component variant with its caption underneath. */
function Variant({ label, children }: VariantProps) {
  return (
    <div className="flex flex-col items-start gap-1.5">
      <div>{children}</div>
      <span className="text-meta text-muted-foreground">{label}</span>
    </div>
  );
}

function Row({ children }: { children: ReactNode }) {
  return <div className="flex flex-wrap items-start gap-x-8 gap-y-6">{children}</div>;
}

/* ------------------------------------------------------------------ */
/* Demo data                                                          */
/* ------------------------------------------------------------------ */

const colorTokens = [
  "background",
  "card",
  "muted",
  "border",
  "primary",
  "secondary",
  "moss",
  "moss-soft",
  "destructive",
  "destructive-soft",
  "go",
  "go-soft",
  "wait",
  "wait-soft",
] as const;

const swatchClasses: Record<(typeof colorTokens)[number], string> = {
  background: "bg-background",
  card: "bg-card",
  muted: "bg-muted",
  border: "bg-border",
  primary: "bg-primary",
  secondary: "bg-secondary",
  moss: "bg-moss",
  "moss-soft": "bg-moss-soft",
  destructive: "bg-destructive",
  "destructive-soft": "bg-destructive-soft",
  go: "bg-go",
  "go-soft": "bg-go-soft",
  wait: "bg-wait",
  "wait-soft": "bg-wait-soft",
};

const runStates: RunState[] = ["queued", "running", "paused", "finished", "failed", "stale"];

type RunRow = {
  id: string;
  name: string;
  state: RunState;
  cost: string;
  at: Date;
};

const runNames = [
  "Nightly digest",
  "Invoice sync",
  "Ticket triage",
  "Weekly report",
  "Backfill import",
  "Renewal reminders",
  "Churn analysis",
];

const tableRows: RunRow[] = Array.from({ length: 23 }, (_, index) => ({
  id: `run_${(4200 + index).toString(16)}`,
  name: `${runNames[index % runNames.length] ?? "Run"} #${1040 + index}`,
  state: runStates[index % runStates.length] ?? "queued",
  cost: `$0.${String(10 + ((index * 17) % 90)).padStart(2, "0")}`,
  at: new Date(Date.now() - (index + 1) * 37 * 60_000),
}));

const tableColumns: DataTableColumn<RunRow>[] = [
  { key: "name", header: "Name", render: (row) => row.name },
  { key: "state", header: "Status", render: (row) => <RunStateBadge state={row.state} /> },
  {
    key: "cost",
    header: "Cost",
    align: "right",
    render: (row) => <span className="font-mono text-meta">{row.cost}</span>,
  },
  { key: "at", header: "Started", render: (row) => <RelativeTime date={row.at} /> },
];

const largeJson = Array.from({ length: 24 }, (_, index) => ({
  seq: index + 1,
  type: index % 4 === 0 ? "tool.call" : "tool.result",
  ok: index % 5 !== 0,
}));

const longSampleText = [
  "Fetched 214 subscriber records from the CRM export.",
  "Deduplicated 9 entries that shared an email address.",
  "Validated the remaining 205 rows against the schema.",
  "Wrote the cleaned batch to the staging table.",
].join("\n");

/* ------------------------------------------------------------------ */
/* Sections                                                           */
/* ------------------------------------------------------------------ */

function ColorTokensSection() {
  return (
    <Section title="Color tokens">
      <div className="flex flex-wrap gap-4">
        {colorTokens.map((token) => (
          <div key={token} className="flex flex-col items-start gap-1.5">
            <div className={`size-12 rounded-md border ${swatchClasses[token]}`} />
            <span className="font-mono text-meta text-muted-foreground">{token}</span>
          </div>
        ))}
      </div>
    </Section>
  );
}

function TypographySection() {
  return (
    <Section title="Typography">
      <div className="space-y-3">
        <Variant label="text-chrome: 13px UI text">
          <p className="text-chrome">Runs, approvals, and settings use this size for controls.</p>
        </Variant>
        <Variant label="text-meta: 12px descriptions">
          <p className="text-meta text-muted-foreground">
            Secondary descriptions and captions sit one step below chrome.
          </p>
        </Variant>
        <Variant label="text-chat: 15px chat prose">
          <p className="text-chat">Agent replies read at a comfortable prose size.</p>
        </Variant>
        <Variant label="text-log: 12.5px mono log lines">
          <p className="font-mono text-log">12:04:11.352 worker checkpoint saved seq=418</p>
        </Variant>
        <Variant label="13px sentence-case section label">
          <span className="text-chrome font-medium text-muted-foreground">Section label</span>
        </Variant>
        <Variant label="font-mono: the spec register">
          <p className="font-mono text-chrome">run_66a2 · org/support · 2026-07-21T09:14:02Z</p>
        </Variant>
      </div>
    </Section>
  );
}

function ButtonsSection() {
  return (
    <Section title="Buttons">
      <div className="space-y-6">
        <Row>
          <Variant label="default">
            <Button>New run</Button>
          </Variant>
          <Variant label="secondary">
            <Button variant="secondary">Duplicate</Button>
          </Variant>
          <Variant label="outline">
            <Button variant="outline">Export</Button>
          </Variant>
          <Variant label="ghost">
            <Button variant="ghost">Dismiss</Button>
          </Variant>
          <Variant label="destructive">
            <Button variant="destructive">Delete</Button>
          </Variant>
          <Variant label="link">
            <Button variant="link">View run</Button>
          </Variant>
        </Row>
        <Row>
          <Variant label="sm">
            <Button size="sm">Approve</Button>
          </Variant>
          <Variant label="default">
            <Button>Approve</Button>
          </Variant>
          <Variant label="lg">
            <Button size="lg">Approve</Button>
          </Variant>
          <Variant label="icon">
            <Button size="icon" aria-label="Add">
              <Plus />
            </Button>
          </Variant>
          <Variant label="disabled">
            <Button disabled>Approve</Button>
          </Variant>
        </Row>
      </div>
    </Section>
  );
}

function FormControlsSection() {
  return (
    <Section title="Form controls">
      <div className="grid max-w-3xl gap-6 sm:grid-cols-2">
        <div className="space-y-2">
          <Label htmlFor="gallery-name">Input</Label>
          <Input id="gallery-name" placeholder="Connector name" />
        </div>
        <div className="space-y-2">
          <Label htmlFor="gallery-invalid">Input with error</Label>
          <Input id="gallery-invalid" aria-invalid placeholder="Required field" />
        </div>
        <div className="space-y-2 sm:col-span-2">
          <Label htmlFor="gallery-notes">Textarea</Label>
          <Textarea id="gallery-notes" placeholder="Notes for the reviewer…" />
        </div>
        <div className="space-y-2">
          <Label>Select</Label>
          <Select defaultValue="hourly">
            <SelectTrigger className="w-full">
              <SelectValue placeholder="Schedule" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="hourly">Every hour</SelectItem>
              <SelectItem value="daily">Every day</SelectItem>
              <SelectItem value="weekly">Every week</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-3">
          <Label>Radio group</Label>
          <RadioGroup defaultValue="team" className="gap-2">
            <div className="flex items-center gap-2">
              <RadioGroupItem value="person" id="gallery-scope-person" />
              <Label htmlFor="gallery-scope-person">Person</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="team" id="gallery-scope-team" />
              <Label htmlFor="gallery-scope-team">Team</Label>
            </div>
            <div className="flex items-center gap-2">
              <RadioGroupItem value="org" id="gallery-scope-org" />
              <Label htmlFor="gallery-scope-org">Organization</Label>
            </div>
          </RadioGroup>
        </div>
        <div className="flex items-center gap-2">
          <Checkbox id="gallery-notify" defaultChecked />
          <Label htmlFor="gallery-notify">Notify on failure</Label>
        </div>
        <div className="flex items-center gap-2">
          <Switch id="gallery-autorun" defaultChecked />
          <Label htmlFor="gallery-autorun">Run automatically</Label>
        </div>
      </div>
    </Section>
  );
}

function BadgesSection() {
  return (
    <Section title="Badges & status">
      <div className="space-y-6">
        <Row>
          <Variant label="Badge default">
            <Badge>Default</Badge>
          </Variant>
          <Variant label="secondary">
            <Badge variant="secondary">Secondary</Badge>
          </Variant>
          <Variant label="outline">
            <Badge variant="outline">Outline</Badge>
          </Variant>
          <Variant label="destructive">
            <Badge variant="destructive">Destructive</Badge>
          </Variant>
          <Variant label="ghost">
            <Badge variant="ghost">Ghost</Badge>
          </Variant>
          <Variant label="link">
            <Badge variant="link">Link</Badge>
          </Variant>
        </Row>
        <Row>
          {(["go", "wait", "run", "destructive", "neutral"] as const).map((tone) => (
            <Variant key={tone} label={`StatusDot ${tone}`}>
              <div className="flex h-5 items-center">
                <StatusDot tone={tone} />
              </div>
            </Variant>
          ))}
        </Row>
        <Row>
          {runStates.map((state) => (
            <Variant key={state} label={`RunStateBadge ${state}`}>
              <RunStateBadge state={state} />
            </Variant>
          ))}
        </Row>
        <Row>
          {(["read", "write", "destructive"] as const).map((sensitivity) => (
            <Variant key={sensitivity} label={`SensitivityBadge ${sensitivity}`}>
              <SensitivityBadge sensitivity={sensitivity} />
            </Variant>
          ))}
        </Row>
        <Row>
          {(["connected", "missing", "expired"] as const).map((status) => (
            <Variant key={status} label={`CredentialStatusBadge ${status}`}>
              <CredentialStatusBadge status={status} />
            </Variant>
          ))}
        </Row>
        <Row>
          <Variant label="ScopeBadge short">
            <ScopeBadge scope="org/support" />
          </Variant>
          <Variant label="ScopeBadge long path">
            <ScopeBadge scope="org/engineering/platform/runtime" />
          </Variant>
        </Row>
      </div>
    </Section>
  );
}

function IdentitySection() {
  return (
    <Section title="Identity atoms">
      <div className="space-y-6">
        <Row>
          <Variant label="IdChip default truncation">
            <IdChip id="run_9f3b2c81a6d54e07b1c2" />
          </Variant>
          <Variant label="IdChip visibleChars 12">
            <IdChip id="run_9f3b2c81a6d54e07b1c2" visibleChars={12} />
          </Variant>
          <Variant label="IdChip short id">
            <IdChip id="run_42" />
          </Variant>
          <Variant label="CopyButton">
            <CopyButton value="run_9f3b2c81a6d54e07b1c2" />
          </Variant>
        </Row>
        <Row>
          <Variant label="RelativeTime minutes ago">
            <RelativeTime date={new Date(Date.now() - 12 * 60_000)} />
          </Variant>
          <Variant label="hours ago">
            <RelativeTime date={new Date(Date.now() - 3 * 3_600_000)} />
          </Variant>
          <Variant label="days ago">
            <RelativeTime date={new Date(Date.now() - 4 * 86_400_000)} />
          </Variant>
          <Variant label="future">
            <RelativeTime date={new Date(Date.now() + 2 * 3_600_000)} />
          </Variant>
        </Row>
        <Variant label="KeyValueList: plain, mono, and ReactNode values">
          <KeyValueList
            className="w-96 max-w-full"
            items={[
              { label: "Name", value: "Nightly digest" },
              { label: "Run id", value: "run_9f3b2c81", mono: true },
              { label: "Status", value: <RunStateBadge state="running" /> },
            ]}
          />
        </Variant>
      </div>
    </Section>
  );
}

function OverlaysSection() {
  const [toastCount, setToastCount] = useState(0);

  return (
    <Section title="Overlays">
      <div className="space-y-6">
        <Row>
          <Variant label="Dialog">
            <Dialog>
              <DialogTrigger asChild>
                <Button variant="outline">Rename run</Button>
              </DialogTrigger>
              <DialogContent>
                <DialogHeader>
                  <DialogTitle>Rename run</DialogTitle>
                  <DialogDescription>
                    The new name shows in the run list and in surface messages.
                  </DialogDescription>
                </DialogHeader>
                <Input defaultValue="Nightly digest #1041" />
                <DialogFooter>
                  <DialogClose asChild>
                    <Button variant="outline">Cancel</Button>
                  </DialogClose>
                  <DialogClose asChild>
                    <Button>Save</Button>
                  </DialogClose>
                </DialogFooter>
              </DialogContent>
            </Dialog>
          </Variant>
          <Variant label="AlertDialog">
            <AlertDialog>
              <AlertDialogTrigger asChild>
                <Button variant="outline">Remove connector</Button>
              </AlertDialogTrigger>
              <AlertDialogContent>
                <AlertDialogHeader>
                  <AlertDialogTitle>Remove the Linear connector?</AlertDialogTitle>
                  <AlertDialogDescription>
                    Runs that call Linear tools fail until you reconnect it.
                  </AlertDialogDescription>
                </AlertDialogHeader>
                <AlertDialogFooter>
                  <AlertDialogCancel>Cancel</AlertDialogCancel>
                  <AlertDialogAction>Remove</AlertDialogAction>
                </AlertDialogFooter>
              </AlertDialogContent>
            </AlertDialog>
          </Variant>
          <Variant label="Sheet">
            <Sheet>
              <SheetTrigger asChild>
                <Button variant="outline">Open details</Button>
              </SheetTrigger>
              <SheetContent>
                <SheetHeader>
                  <SheetTitle>Run details</SheetTitle>
                  <SheetDescription>Side panel for inspectors and detail views.</SheetDescription>
                </SheetHeader>
              </SheetContent>
            </Sheet>
          </Variant>
          <Variant label="Popover">
            <Popover>
              <PopoverTrigger asChild>
                <Button variant="outline">Show schedule</Button>
              </PopoverTrigger>
              <PopoverContent className="w-64 text-chrome">
                Runs every day at 06:00 in the org timezone.
              </PopoverContent>
            </Popover>
          </Variant>
          <Variant label="Tooltip">
            <TooltipProvider>
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button variant="outline">Hover me</Button>
                </TooltipTrigger>
                <TooltipContent>Short hint text</TooltipContent>
              </Tooltip>
            </TooltipProvider>
          </Variant>
          <Variant label="DropdownMenu">
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button variant="outline">Actions</Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="start">
                <DropdownMenuLabel>Run actions</DropdownMenuLabel>
                <DropdownMenuItem>
                  Duplicate
                  <DropdownMenuShortcut>⌘D</DropdownMenuShortcut>
                </DropdownMenuItem>
                <DropdownMenuItem>Export</DropdownMenuItem>
                <DropdownMenuCheckboxItem checked>Pin to top</DropdownMenuCheckboxItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive">Delete</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </Variant>
          <Variant label="Sonner toast">
            <Button
              variant="outline"
              onClick={() => {
                setToastCount((count) => count + 1);
                toast("Run archived", {
                  description: `Toast ${toastCount + 1}. Undo is available for 10s.`,
                });
              }}
            >
              Fire toast
            </Button>
          </Variant>
        </Row>
        <Variant label="Command: static, inside a bordered frame">
          <Command className="w-80 rounded-lg border">
            <CommandInput placeholder="Type a command…" />
            <CommandList>
              <CommandEmpty>No results found.</CommandEmpty>
              <CommandGroup heading="Navigate">
                <CommandItem>
                  <Search />
                  Search runs
                  <CommandShortcut>⌘K</CommandShortcut>
                </CommandItem>
                <CommandItem>
                  <CalendarClock />
                  Automations
                </CommandItem>
              </CommandGroup>
              <CommandSeparator />
              <CommandGroup heading="Account">
                <CommandItem>
                  <UserIcon />
                  Profile
                </CommandItem>
                <CommandItem>
                  <SettingsIcon />
                  Settings
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </Variant>
        <Variant label="Tabs">
          <Tabs defaultValue="overview" className="w-96 max-w-full">
            <TabsList>
              <TabsTrigger value="overview">Overview</TabsTrigger>
              <TabsTrigger value="events">Events</TabsTrigger>
              <TabsTrigger value="logs">Logs</TabsTrigger>
            </TabsList>
            <TabsContent value="overview" className="text-chrome text-muted-foreground">
              Overview content.
            </TabsContent>
            <TabsContent value="events" className="text-chrome text-muted-foreground">
              Events content.
            </TabsContent>
            <TabsContent value="logs" className="text-chrome text-muted-foreground">
              Logs content.
            </TabsContent>
          </Tabs>
        </Variant>
      </div>
    </Section>
  );
}

function ApprovalsSection() {
  return (
    <Section title="Approval card" bare>
      <div className="grid gap-4 lg:grid-cols-2">
        <Variant label="Pending with action">
          <ApprovalCard
            className="w-105 max-w-full"
            headline="Create an issue in Linear"
            kind="approval"
            action={{
              toolTitle: "Create issue",
              connector: "Linear",
              sensitivity: "write",
              argsSummary: '{"team":"SUP","title":"Widget fails to sync","priority":2}',
            }}
            requestedBy="Nightly digest #1041"
            options={[
              { id: "approve", label: "Approve", variant: "primary" },
              { id: "deny", label: "Deny", variant: "destructive" },
            ]}
            expiresAt={new Date(Date.now() + 45 * 60_000)}
            runHref="#"
            onResolve={(optionId) => toast(`Resolved: ${optionId}`)}
          />
        </Variant>
        <Variant label="Pending confirmation (prompt only)">
          <ApprovalCard
            className="w-105 max-w-full"
            headline="Confirm before sending"
            kind="confirmation"
            prompt="Send the weekly digest to 214 subscribers now?"
            requestedBy="Weekly report #1046"
            options={[
              { id: "confirm", label: "Send now", variant: "primary" },
              { id: "cancel", label: "Cancel", variant: "secondary" },
            ]}
            onResolve={(optionId) => toast(`Resolved: ${optionId}`)}
          />
        </Variant>
        <Variant label="Resolved: approved">
          <ApprovalCard
            className="w-105 max-w-full"
            headline="Create an issue in Linear"
            kind="approval"
            action={{
              toolTitle: "Create issue",
              connector: "Linear",
              sensitivity: "write",
              argsSummary: '{"team":"SUP","title":"Widget fails to sync","priority":2}',
            }}
            requestedBy="Nightly digest #1041"
            options={[]}
            runHref="#"
            resolution={{ outcome: "approved", by: "Nelson", at: new Date() }}
          />
        </Variant>
        <Variant label="Resolved: denied">
          <ApprovalCard
            className="w-105 max-w-full"
            headline="Delete 12 stale records"
            kind="approval"
            action={{
              toolTitle: "Delete records",
              connector: "CRM",
              sensitivity: "destructive",
              argsSummary: '{"table":"contacts","ids":[311,318,319,…]}',
            }}
            requestedBy="Backfill import #1044"
            options={[]}
            resolution={{ outcome: "denied", by: "Ada", at: new Date() }}
          />
        </Variant>
        <Variant label="Resolved: expired">
          <ApprovalCard
            className="w-105 max-w-full"
            headline="Confirm before sending"
            kind="confirmation"
            prompt="Send the weekly digest to 214 subscribers now?"
            requestedBy="Weekly report #1046"
            options={[]}
            resolution={{ outcome: "expired" }}
          />
        </Variant>
      </div>
    </Section>
  );
}

function TimelineSection() {
  return (
    <Section title="Run timeline" bare>
      <div className="space-y-6">
        <div className="max-w-215 space-y-4 rounded-md border bg-card p-6">
          <SteeringNote author="Nelson" at={new Date(Date.now() - 4 * 3_600_000)}>
            Skip anything already triaged this week and keep titles short.
          </SteeringNote>
          <ActivityCard
            title="Create issue"
            kind="linear.issues.create"
            state="ok"
            input='{"team":"SUP","title":"Widget fails to sync"}'
            resultSummary="Created SUP-482 and assigned it to the support queue."
          >
            <OutputViewer
              output={{
                type: "json",
                value: { id: "SUP-482", status: "created", assignee: null },
              }}
            />
          </ActivityCard>
          <ReasoningBlock>
            The three reports describe the same sync failure, so one issue with the earliest
            timestamp keeps the queue clean.
          </ReasoningBlock>
          <ReasoningBlock redacted />
          <SegmentDivider reason="paused" detail="waited 3h for Nelson" />
          <ActivityCard
            title="Post summary"
            kind="slack.chat.postMessage"
            state="running"
            notes="Waiting for the Slack API to acknowledge the message."
          />
          <ErrorItem
            title="Turn failed"
            message="connector timeout after 30s: slack.chat.postMessage"
            stopReason="connector_timeout"
          />
          <UnknownEventsLine count={3} />
        </div>
        <div className="grid gap-4 lg:grid-cols-3">
          <Variant label="OutputViewer json: large array, collapsed">
            <OutputViewer className="w-full min-w-64" output={{ type: "json", value: largeJson }} />
          </Variant>
          <Variant label="OutputViewer text">
            <OutputViewer
              className="w-full min-w-64"
              output={{ type: "text", value: longSampleText }}
            />
          </Variant>
          <Variant label="OutputViewer text: truncated">
            <OutputViewer
              className="w-full min-w-64"
              output={{ type: "text", value: longSampleText }}
              truncated
            />
          </Variant>
        </div>
      </div>
    </Section>
  );
}

function LogsSection() {
  return (
    <Section title="Logs" bare>
      <div className="overflow-hidden rounded-md border bg-card py-1">
        <LogLine level="info" timestamp="12:04:09.101" message="run started run_9f3b2c81 seq=1" />
        <LogLine
          level="info"
          timestamp="12:04:09.348"
          message="tool call linear.issues.create team=SUP"
        />
        <LogLine
          level="warn"
          timestamp="12:04:11.352"
          message="retrying connector call (attempt 2/3) latency=1832ms"
        />
        <LogLine level="info" timestamp="12:04:12.019" message="checkpoint saved seq=418" />
        <LogLine
          level="error"
          timestamp="12:04:42.007"
          message="connector timeout after 30s: slack.chat.postMessage"
        />
        <LogLine
          level="info"
          timestamp="12:04:42.101"
          message="turn recorded stopReason=connector_timeout"
        />
      </div>
    </Section>
  );
}

function AdminSection() {
  const [search, setSearch] = useState("");
  const [stateFilter, setStateFilter] = useState("failed");
  const [connectorFilter, setConnectorFilter] = useState("all");

  return (
    <Section title="Admin grammar" bare>
      <div className="space-y-8">
        <SettingsSection
          title="Automations"
          description="Defaults applied to every automation in this scope."
        >
          <SettingRow
            label="Run automatically"
            description="Start scheduled runs without a manual kick-off."
            control={<Switch defaultChecked />}
          />
          <SettingRow
            label="Failure notifications"
            description="Where to send an alert when a run fails."
            control={
              <Select defaultValue="email">
                <SelectTrigger size="sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="email">Email</SelectItem>
                  <SelectItem value="slack">Slack</SelectItem>
                  <SelectItem value="none">Off</SelectItem>
                </SelectContent>
              </Select>
            }
          />
          <SettingRow
            label="API key"
            description="Rotate the key used by scripts in this scope."
            control={
              <Button variant="outline" size="sm">
                Rotate key
              </Button>
            }
          />
          <SettingRow
            orientation="stack"
            label="Standing instructions"
            description="Prepended to every run in this scope."
            control={<Textarea placeholder="Keep summaries under five sentences…" />}
          />
        </SettingsSection>

        <div className="space-y-3">
          <FilterBar>
            <FilterSearch value={search} onValueChange={setSearch} placeholder="Search runs…" />
            <FilterSelect
              label="State"
              value={stateFilter}
              onValueChange={setStateFilter}
              options={[
                { value: "all", label: "All states" },
                { value: "running", label: "Running" },
                { value: "failed", label: "Failed" },
                { value: "finished", label: "Finished" },
              ]}
            />
            <FilterSelect
              label="Connector"
              value={connectorFilter}
              onValueChange={setConnectorFilter}
              options={[
                { value: "all", label: "All connectors" },
                { value: "linear", label: "Linear" },
                { value: "slack", label: "Slack" },
              ]}
            />
          </FilterBar>
          <p className="text-meta text-muted-foreground">
            FilterBar: the state filter is at a non-default value, so it shows the moss tint.
          </p>
        </div>

        <div className="space-y-1.5">
          <DataTable
            columns={tableColumns}
            rows={tableRows}
            rowKey={(row) => row.id}
            pageSize={5}
            onRowClick={(row) => toast(`Open ${row.name}`)}
          />
          <p className="text-meta text-muted-foreground">
            DataTable: 23 rows, page size 5, row click fires a toast.
          </p>
        </div>

        <div className="space-y-1.5">
          <DataTable columns={tableColumns} rows={[]} rowKey={(row: RunRow) => row.id} loading />
          <p className="text-meta text-muted-foreground">DataTable: loading state.</p>
        </div>

        <div className="space-y-1.5">
          <DataTable
            columns={tableColumns}
            rows={[]}
            rowKey={(row: RunRow) => row.id}
            empty={
              <EmptyState
                icon={Inbox}
                title="No runs yet"
                description="Runs appear here once an automation or a chat kicks one off."
                action={<Button size="sm">New run</Button>}
              />
            }
          />
          <p className="text-meta text-muted-foreground">
            DataTable: empty with custom EmptyState.
          </p>
        </div>

        <div className="space-y-1.5">
          <div className="rounded-md border bg-card">
            <EmptyState
              icon={Inbox}
              title="No connectors"
              description="Connect a tool to let the agent act on your behalf."
              action={
                <Button variant="outline" size="sm">
                  Add connector
                </Button>
              }
            />
          </div>
          <p className="text-meta text-muted-foreground">EmptyState: standalone.</p>
        </div>
      </div>
    </Section>
  );
}

function ChatSection() {
  return (
    <Section title="Chat" bare>
      <div className="space-y-1.5">
        <ThreadDemo />
        <p className="text-meta text-muted-foreground">
          ThreadDemo: self-contained thread with canned streaming. ThreadList needs the app runtime
          and renders inside the app sidebar, so it is not mounted here.
        </p>
      </div>
    </Section>
  );
}

function BrandSection() {
  return (
    <Section title="Brand and auth layout">
      <Row>
        <Variant label="LogoMark">
          <LogoMark className="size-7" />
        </Variant>
        <Variant label="Wordmark: auth pages">
          <Wordmark className="h-6 w-auto" />
        </Variant>
        <Variant label="Auth layout: centered 360px column on card">
          <div className="w-[360px] border-y bg-card py-10 text-center">
            <Wordmark className="mx-auto h-6 w-auto" />
            <p className="mt-3 text-lg font-semibold">Sign in to Trema</p>
            <p className="mt-2 text-meta text-muted-foreground">Forms sit directly on the page.</p>
          </div>
        </Variant>
      </Row>
    </Section>
  );
}

/* ------------------------------------------------------------------ */
/* Page                                                               */
/* ------------------------------------------------------------------ */

function Gallery() {
  return (
    <div className="mx-auto w-full max-w-5xl px-6 py-8">
      <PageHeader
        title="Design system"
        description="Every component in every state. Flip the theme from the top bar."
      />
      <div className="space-y-10">
        <ColorTokensSection />
        <TypographySection />
        <BrandSection />
        <ButtonsSection />
        <FormControlsSection />
        <BadgesSection />
        <IdentitySection />
        <OverlaysSection />
        <ApprovalsSection />
        <TimelineSection />
        <LogsSection />
        <AdminSection />
        <ChatSection />
      </div>
    </div>
  );
}

export { Gallery };
