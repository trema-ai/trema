import braveIcon from "@lobehub/icons-static-svg/icons/brave-color.svg";
import exaIcon from "@lobehub/icons-static-svg/icons/exa-color.svg";
import firecrawlIcon from "@lobehub/icons-static-svg/icons/firecrawl-color.svg";
import searxngIcon from "@lobehub/icons-static-svg/icons/searxng-color.svg";
import tavilyIcon from "@lobehub/icons-static-svg/icons/tavily-color.svg";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Globe2, MoreHorizontal } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "#web/components/trema/page-header.tsx";
import { SettingRow, SettingsSection } from "#web/components/trema/settings-section.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#web/components/ui/alert-dialog.tsx";
import { Badge } from "#web/components/ui/badge.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "#web/components/ui/dropdown-menu.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "#web/components/ui/tabs.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";

type CapabilityKey = "web.search" | "web.fetch";
type DriverKey =
  | "brave_search"
  | "tavily_search"
  | "firecrawl"
  | "searxng"
  | "ddgs"
  | "exa"
  | "parallel";

type CapabilityDriver = {
  key: DriverKey;
  label: string;
  capabilities: CapabilityKey[];
  credentialRequired: boolean;
  defaultSettings: Record<string, unknown>;
};

type CapabilityProvider = {
  name: string;
  label: string;
  driverKey: DriverKey;
  capabilities: CapabilityKey[];
  hasCredential: boolean;
  settings: Record<string, unknown>;
  updatedAt: string;
};

type CapabilityRoute = {
  capabilityKey: CapabilityKey;
  chain: string[];
  updatedAt: string;
};

const providerNames: Record<DriverKey, string> = {
  brave_search: "brave-search",
  tavily_search: "tavily-search",
  firecrawl: "firecrawl",
  searxng: "searxng",
  ddgs: "ddgs",
  exa: "exa",
  parallel: "parallel",
};

const providerIcons: Partial<Record<DriverKey, string>> = {
  brave_search: braveIcon,
  tavily_search: tavilyIcon,
  firecrawl: firecrawlIcon,
  searxng: searxngIcon,
  ddgs: "/capability-icons/duckduckgo.svg",
  exa: exaIcon,
  parallel: "/capability-icons/parallel.svg",
};

const providerDescriptions: Record<DriverKey, Record<CapabilityKey, string>> = {
  brave_search: {
    "web.search": "Uses the Brave Web Search API.",
    "web.fetch": "Brave does not provide web extraction.",
  },
  tavily_search: {
    "web.search": "Uses Tavily Search with basic-depth results.",
    "web.fetch": "Uses Tavily Extract with basic-depth extraction.",
  },
  firecrawl: {
    "web.search": "Uses Firecrawl Search v2.",
    "web.fetch": "Uses Firecrawl Scrape v2 for clean Markdown.",
  },
  searxng: {
    "web.search": "Uses the JSON API of your SearXNG instance.",
    "web.fetch": "SearXNG does not provide web extraction.",
  },
  ddgs: {
    "web.search": "Uses your self-hosted DDGS metasearch API.",
    "web.fetch": "Uses your self-hosted DDGS extraction API.",
  },
  exa: {
    "web.search": "Uses Exa Search with query-relevant highlights.",
    "web.fetch": "Uses Exa Contents with text extraction.",
  },
  parallel: {
    "web.search": "Uses Parallel Search with LLM-optimized excerpts.",
    "web.fetch": "Uses Parallel Extract for readable page content.",
  },
};

function messageFrom(error: unknown): string {
  return error instanceof Error ? error.message : "The request failed";
}

export function SettingsCapabilitiesPage() {
  const queryClient = useQueryClient();
  const drivers = useQuery(orpc.capabilities.drivers.list.queryOptions({}));
  const providers = useQuery(orpc.capabilities.providers.list.queryOptions({}));
  const routes = useQuery(orpc.capabilities.routes.list.queryOptions({}));
  const driverRows = (drivers.data ?? []) as CapabilityDriver[];
  const providerRows = (providers.data ?? []) as CapabilityProvider[];
  const routeRows = (routes.data ?? []) as CapabilityRoute[];
  const error = drivers.error ?? providers.error ?? routes.error;
  const pending = drivers.isPending || providers.isPending || routes.isPending;

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.capabilities.providers.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.capabilities.routes.list.key() }),
    ]);
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Capabilities"
        description="Configure the native tools the agent can use and the backends that serve them."
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <div className="space-y-4">
          {[1, 2].map((key) => (
            <div key={key} className="h-48 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      ) : (
        <Tabs defaultValue="web-search">
          <TabsList className="mb-3">
            <TabsTrigger value="web-search">Web Search</TabsTrigger>
            <TabsTrigger value="web-extract">Web Extract</TabsTrigger>
          </TabsList>
          <TabsContent value="web-search">
            <WebCapabilitySections
              capabilityKey="web.search"
              drivers={driverRows.filter((driver) => driver.capabilities.includes("web.search"))}
              providers={providerRows.filter((provider) =>
                provider.capabilities.includes("web.search"),
              )}
              route={routeRows.find((route) => route.capabilityKey === "web.search")}
              onChanged={invalidate}
            />
          </TabsContent>
          <TabsContent value="web-extract">
            <WebCapabilitySections
              capabilityKey="web.fetch"
              drivers={driverRows.filter((driver) => driver.capabilities.includes("web.fetch"))}
              providers={providerRows.filter((provider) =>
                provider.capabilities.includes("web.fetch"),
              )}
              route={routeRows.find((route) => route.capabilityKey === "web.fetch")}
              onChanged={invalidate}
            />
          </TabsContent>
        </Tabs>
      )}
    </main>
  );
}

function WebCapabilitySections({
  capabilityKey,
  drivers,
  providers,
  route,
  onChanged,
}: {
  capabilityKey: CapabilityKey;
  drivers: CapabilityDriver[];
  providers: CapabilityProvider[];
  route: CapabilityRoute | undefined;
  onChanged: () => Promise<void>;
}) {
  const extracts = capabilityKey === "web.fetch";
  return (
    <SettingsSection
      title="Providers"
      description={
        extracts
          ? "Extraction providers return a page as one normalized, bounded text result."
          : "Search providers return ranked results in one normalized shape."
      }
    >
      {drivers.map((driver) => (
        <CapabilityProviderRow
          key={driver.key}
          capabilityKey={capabilityKey}
          driver={driver}
          provider={providers.find((provider) => provider.driverKey === driver.key)}
          route={route}
          autoEnable={route === undefined}
          onChanged={onChanged}
        />
      ))}
    </SettingsSection>
  );
}

function CapabilityProviderRow({
  capabilityKey,
  driver,
  provider,
  route,
  autoEnable,
  onChanged,
}: {
  capabilityKey: CapabilityKey;
  driver: CapabilityDriver;
  provider: CapabilityProvider | undefined;
  route: CapabilityRoute | undefined;
  autoEnable: boolean;
  onChanged: () => Promise<void>;
}) {
  const [configureOpen, setConfigureOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const name = providerNames[driver.key];
  const routePosition = route?.chain.indexOf(name) ?? -1;
  const configured =
    provider !== undefined && (!driver.credentialRequired || provider.hasCredential);
  const icon = providerIcons[driver.key];
  const remove = useMutation({
    mutationFn: () => rpcClient.capabilities.providers.remove({ name }),
    onSuccess: async () => {
      setRemoveOpen(false);
      await onChanged();
      toast.success(`${driver.label} removed`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const setRole = useMutation({
    mutationFn: (role: "primary" | "fallback") => {
      const chain = route?.chain ?? [];
      const nextChain =
        role === "primary"
          ? [name, ...chain.filter((providerName) => providerName !== name)].slice(0, 2)
          : [chain[0]!, name];
      return rpcClient.capabilities.routes.put({ capabilityKey, chain: nextChain });
    },
    onSuccess: async (_, role) => {
      await onChanged();
      toast.success(`${driver.label} is now the ${role} provider`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <>
      <SettingRow
        label={driver.label}
        icon={
          icon ? (
            <img
              src={icon}
              alt=""
              className="size-9 shrink-0 rounded-md border bg-white object-contain p-1.5"
            />
          ) : (
            <span className="flex size-9 shrink-0 items-center justify-center rounded-md border bg-muted/30">
              <Globe2 className="size-5" />
            </span>
          )
        }
        description={providerDescriptions[driver.key][capabilityKey]}
        control={
          <div className="flex items-center gap-2">
            {routePosition === 0 ? <Badge variant="secondary">Primary</Badge> : null}
            {routePosition === 1 ? <Badge variant="outline">Fallback</Badge> : null}
            {configured && routePosition < 0 ? <Badge variant="outline">Configured</Badge> : null}
            {!configured ? (
              <Button variant="outline" size="sm" onClick={() => setConfigureOpen(true)}>
                Configure
              </Button>
            ) : null}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon-sm"
                  aria-label={`${driver.label} actions`}
                  disabled={remove.isPending || setRole.isPending}
                >
                  <MoreHorizontal />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setConfigureOpen(true)}>
                  Configure
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={!configured || routePosition === 0}
                  onSelect={() => setRole.mutate("primary")}
                >
                  Make primary
                </DropdownMenuItem>
                <DropdownMenuItem
                  disabled={
                    !configured || route === undefined || routePosition === 0 || routePosition === 1
                  }
                  onSelect={() => setRole.mutate("fallback")}
                >
                  Make fallback
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  variant="destructive"
                  disabled={provider === undefined}
                  onSelect={() => setRemoveOpen(true)}
                >
                  Remove
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      <ProviderConfigurationDialog
        capabilityKey={capabilityKey}
        driver={driver}
        provider={provider}
        name={name}
        autoEnable={autoEnable}
        open={configureOpen}
        onOpenChange={setConfigureOpen}
        onChanged={onChanged}
      />
      <AlertDialog open={removeOpen} onOpenChange={setRemoveOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {driver.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Its API key is deleted and it is removed from every route that uses it.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}

function ProviderConfigurationDialog({
  capabilityKey,
  driver,
  provider,
  name,
  autoEnable,
  open,
  onOpenChange,
  onChanged,
}: {
  capabilityKey: CapabilityKey;
  driver: CapabilityDriver;
  provider: CapabilityProvider | undefined;
  name: string;
  autoEnable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  const [baseUrl, setBaseUrl] = useState("");
  const serviceUrlRequired = typeof driver.defaultSettings.baseUrl === "string";
  useEffect(() => {
    if (!open) {
      setApiKey("");
      return;
    }
    const configuredUrl = provider?.settings.baseUrl;
    const defaultUrl = driver.defaultSettings.baseUrl;
    setBaseUrl(
      typeof configuredUrl === "string"
        ? configuredUrl
        : typeof defaultUrl === "string"
          ? defaultUrl
          : "",
    );
  }, [driver.defaultSettings.baseUrl, open, provider?.settings.baseUrl]);
  const save = useMutation({
    mutationFn: async () => {
      await rpcClient.capabilities.providers.put({
        name,
        label: driver.label,
        driverKey: driver.key,
        ...(driver.credentialRequired
          ? { credential: apiKey.trim() }
          : serviceUrlRequired
            ? { settings: { baseUrl: baseUrl.trim() } }
            : { settings: {} }),
      });
      if (autoEnable) {
        await rpcClient.capabilities.routes.put({
          capabilityKey,
          chain: [name],
        });
      }
    },
    onSuccess: async () => {
      onOpenChange(false);
      await onChanged();
      toast.success(`${driver.label} configured`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>Configure {driver.label}</DialogTitle>
            <DialogDescription>
              {driver.credentialRequired
                ? "The API key is encrypted and cannot be read back after it is saved."
                : serviceUrlRequired
                  ? "Enter the HTTP or HTTPS URL Trema can use to reach this service."
                  : "This provider runs inside Trema and does not require credentials or a service URL."}
            </DialogDescription>
          </DialogHeader>
          <div className="py-5">
            {driver.credentialRequired ? (
              <>
                <Label htmlFor={`${driver.key}-key`}>API key</Label>
                <Input
                  id={`${driver.key}-key`}
                  type="password"
                  autoComplete="off"
                  className="mt-2"
                  value={apiKey}
                  onChange={(event) => setApiKey(event.target.value)}
                />
              </>
            ) : serviceUrlRequired ? (
              <>
                <Label htmlFor={`${driver.key}-url`}>Service URL</Label>
                <Input
                  id={`${driver.key}-url`}
                  type="url"
                  inputMode="url"
                  autoComplete="url"
                  className="mt-2"
                  placeholder="http://localhost:8080"
                  value={baseUrl}
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                Save this provider to make it available for capability routes.
              </p>
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button
              disabled={
                (driver.credentialRequired
                  ? apiKey.trim() === ""
                  : serviceUrlRequired && baseUrl.trim() === "") || save.isPending
              }
            >
              {save.isPending
                ? "Saving…"
                : driver.credentialRequired
                  ? "Save key"
                  : serviceUrlRequired
                    ? "Save"
                    : "Enable"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
