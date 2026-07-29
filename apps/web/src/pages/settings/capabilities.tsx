import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { CredentialStatusBadge } from "#web/components/trema/credential-status-badge.tsx";
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
import { Button } from "#web/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { Switch } from "#web/components/ui/switch.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";

type CapabilityKey = "web.search" | "web.fetch";
type DriverKey = "brave_search" | "tavily_search" | "builtin_web_fetch";

type CapabilityDriver = {
  key: DriverKey;
  label: string;
  capability: CapabilityKey;
  credentialRequired: boolean;
  defaultSettings: Record<string, unknown>;
};

type CapabilityProvider = {
  name: string;
  label: string;
  driverKey: DriverKey;
  capability: CapabilityKey;
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
  builtin_web_fetch: "builtin-web-fetch",
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
        <div className="space-y-7">
          <WebSearchSection
            drivers={driverRows.filter((driver) => driver.capability === "web.search")}
            providers={providerRows.filter(
              (provider) => provider.capability === "web.search",
            )}
            route={routeRows.find((route) => route.capabilityKey === "web.search")}
            onChanged={invalidate}
          />
          <WebFetchSection
            driver={driverRows.find((driver) => driver.key === "builtin_web_fetch")}
            provider={providerRows.find(
              (provider) => provider.driverKey === "builtin_web_fetch",
            )}
            route={routeRows.find((route) => route.capabilityKey === "web.fetch")}
            onChanged={invalidate}
          />
        </div>
      )}
    </main>
  );
}

function WebSearchSection({
  drivers,
  providers,
  route,
  onChanged,
}: {
  drivers: CapabilityDriver[];
  providers: CapabilityProvider[];
  route: CapabilityRoute | undefined;
  onChanged: () => Promise<void>;
}) {
  return (
    <SettingsSection
      title="Web search"
      description="Search providers return one normalized result shape. The next provider runs when an earlier one fails."
    >
      {drivers.map((driver) => (
        <SearchProviderRow
          key={driver.key}
          driver={driver}
          provider={providers.find((provider) => provider.driverKey === driver.key)}
          autoEnable={route === undefined}
          onChanged={onChanged}
        />
      ))}
      <SearchRouteRow providers={providers} route={route} onChanged={onChanged} />
    </SettingsSection>
  );
}

function SearchProviderRow({
  driver,
  provider,
  autoEnable,
  onChanged,
}: {
  driver: CapabilityDriver;
  provider: CapabilityProvider | undefined;
  autoEnable: boolean;
  onChanged: () => Promise<void>;
}) {
  const [configureOpen, setConfigureOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);
  const name = providerNames[driver.key];
  const remove = useMutation({
    mutationFn: () => rpcClient.capabilities.providers.remove({ name }),
    onSuccess: async () => {
      setRemoveOpen(false);
      await onChanged();
      toast.success(`${driver.label} removed`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <>
      <SettingRow
        label={driver.label}
        description={
          driver.key === "brave_search"
            ? "Uses the Brave Web Search API."
            : "Uses Tavily Search with basic-depth results."
        }
        control={
          <div className="flex items-center gap-3">
            <CredentialStatusBadge
              status={provider?.hasCredential ? "connected" : "missing"}
              label={provider?.hasCredential ? "Configured" : "Not configured"}
            />
            <Button variant="outline" size="sm" onClick={() => setConfigureOpen(true)}>
              {provider ? "Replace key" : "Configure"}
            </Button>
            {provider ? (
              <Button variant="ghost" size="sm" onClick={() => setRemoveOpen(true)}>
                Remove
              </Button>
            ) : null}
          </div>
        }
      />
      <ProviderCredentialDialog
        driver={driver}
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
              Its API key is deleted and it is removed from the web search route.
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

function ProviderCredentialDialog({
  driver,
  name,
  autoEnable,
  open,
  onOpenChange,
  onChanged,
}: {
  driver: CapabilityDriver;
  name: string;
  autoEnable: boolean;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [apiKey, setApiKey] = useState("");
  useEffect(() => {
    if (!open) setApiKey("");
  }, [open]);
  const save = useMutation({
    mutationFn: async () => {
      await rpcClient.capabilities.providers.put({
        name,
        label: driver.label,
        driverKey: driver.key,
        credential: apiKey.trim(),
      });
      if (autoEnable) {
        await rpcClient.capabilities.routes.put({
          capabilityKey: "web.search",
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
              The API key is encrypted and cannot be read back after it is saved.
            </DialogDescription>
          </DialogHeader>
          <div className="py-5">
            <Label htmlFor={`${driver.key}-key`}>API key</Label>
            <Input
              id={`${driver.key}-key`}
              type="password"
              autoComplete="off"
              className="mt-2"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={apiKey.trim() === "" || save.isPending}>
              {save.isPending ? "Saving…" : "Save key"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function SearchRouteRow({
  providers,
  route,
  onChanged,
}: {
  providers: CapabilityProvider[];
  route: CapabilityRoute | undefined;
  onChanged: () => Promise<void>;
}) {
  const configured = providers.filter((provider) => provider.hasCredential);
  const [enabled, setEnabled] = useState(route !== undefined);
  const [primary, setPrimary] = useState(route?.chain[0] ?? configured[0]?.name ?? "");
  const [fallback, setFallback] = useState(route?.chain[1] ?? "none");
  const routeKey = route?.chain.join("\0") ?? "";
  const providerKey = configured.map(({ name }) => name).join("\0");
  useEffect(() => {
    setEnabled(route !== undefined);
    setPrimary(route?.chain[0] ?? configured[0]?.name ?? "");
    setFallback(route?.chain[1] ?? "none");
  }, [route, routeKey, providerKey]);
  const save = useMutation({
    mutationFn: () =>
      rpcClient.capabilities.routes.put({
        capabilityKey: "web.search",
        chain: enabled
          ? [primary, ...(fallback === "none" || fallback === primary ? [] : [fallback])]
          : [],
      }),
    onSuccess: async () => {
      await onChanged();
      toast.success(enabled ? "Web search route saved" : "Web search disabled");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <SettingRow
      label="Routing"
      description="The primary provider runs first. The fallback runs only after an operational failure."
      orientation="stack"
      control={
        <div className="space-y-4">
          <div className="flex items-center gap-2">
            <Switch
              aria-label="Enable web search"
              checked={enabled}
              disabled={configured.length === 0}
              onCheckedChange={setEnabled}
            />
            <span className="text-chrome">{enabled ? "Enabled" : "Disabled"}</span>
          </div>
          {configured.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              Configure at least one search provider to enable this capability.
            </p>
          ) : enabled ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Primary</Label>
                <Select value={primary} onValueChange={setPrimary}>
                  <SelectTrigger className="mt-2 w-full" aria-label="Primary search provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {configured.map((provider) => (
                      <SelectItem key={provider.name} value={provider.name}>
                        {provider.label}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div>
                <Label>Fallback</Label>
                <Select value={fallback} onValueChange={setFallback}>
                  <SelectTrigger className="mt-2 w-full" aria-label="Fallback search provider">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">None</SelectItem>
                    {configured
                      .filter((provider) => provider.name !== primary)
                      .map((provider) => (
                        <SelectItem key={provider.name} value={provider.name}>
                          {provider.label}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          ) : null}
          <Button
            size="sm"
            disabled={save.isPending || (enabled && primary === "")}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save route"}
          </Button>
        </div>
      }
    />
  );
}

function numericSetting(
  provider: CapabilityProvider | undefined,
  driver: CapabilityDriver | undefined,
  key: string,
  fallback: number,
): number {
  const value = provider?.settings[key] ?? driver?.defaultSettings[key];
  return typeof value === "number" ? value : fallback;
}

function WebFetchSection({
  driver,
  provider,
  route,
  onChanged,
}: {
  driver: CapabilityDriver | undefined;
  provider: CapabilityProvider | undefined;
  route: CapabilityRoute | undefined;
  onChanged: () => Promise<void>;
}) {
  const name = providerNames.builtin_web_fetch;
  const [enabled, setEnabled] = useState(route?.chain.includes(name) ?? false);
  const [timeoutMs, setTimeoutMs] = useState(numericSetting(provider, driver, "timeoutMs", 15_000));
  const [maxBytes, setMaxBytes] = useState(
    numericSetting(provider, driver, "maxBytes", 1_000_000),
  );
  const [maxCharacters, setMaxCharacters] = useState(
    numericSetting(provider, driver, "maxCharacters", 50_000),
  );
  useEffect(() => {
    setEnabled(route?.chain.includes(name) ?? false);
    setTimeoutMs(numericSetting(provider, driver, "timeoutMs", 15_000));
    setMaxBytes(numericSetting(provider, driver, "maxBytes", 1_000_000));
    setMaxCharacters(numericSetting(provider, driver, "maxCharacters", 50_000));
  }, [provider, driver, route]);
  const save = useMutation({
    mutationFn: async () => {
      await rpcClient.capabilities.providers.put({
        name,
        label: driver?.label ?? "Built-in web fetch",
        driverKey: "builtin_web_fetch",
        settings: { timeoutMs, maxBytes, maxCharacters },
      });
      await rpcClient.capabilities.routes.put({
        capabilityKey: "web.fetch",
        chain: enabled ? [name] : [],
      });
    },
    onSuccess: async () => {
      await onChanged();
      toast.success(enabled ? "Web fetch saved" : "Web fetch disabled");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <SettingsSection
      title="Web fetch"
      description="The built-in fetcher reads public HTML, plain text, and JSON without carrying cookies or connector credentials."
    >
      <SettingRow
        label="Availability"
        description="New runs receive the fetch_url tool while this is enabled."
        control={
          <Switch
            aria-label="Enable web fetch"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        }
      />
      <SettingRow
        label="Limits"
        description="Private-network targets stay blocked regardless of these values."
        orientation="stack"
        control={
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <Label htmlFor="fetch-timeout">Timeout (ms)</Label>
              <Input
                id="fetch-timeout"
                type="number"
                min={1_000}
                max={60_000}
                className="mt-2"
                value={timeoutMs}
                onChange={(event) => setTimeoutMs(event.target.valueAsNumber)}
              />
            </div>
            <div>
              <Label htmlFor="fetch-bytes">Response bytes</Label>
              <Input
                id="fetch-bytes"
                type="number"
                min={16_384}
                max={5_000_000}
                className="mt-2"
                value={maxBytes}
                onChange={(event) => setMaxBytes(event.target.valueAsNumber)}
              />
            </div>
            <div>
              <Label htmlFor="fetch-characters">Returned characters</Label>
              <Input
                id="fetch-characters"
                type="number"
                min={1_000}
                max={200_000}
                className="mt-2"
                value={maxCharacters}
                onChange={(event) => setMaxCharacters(event.target.valueAsNumber)}
              />
            </div>
          </div>
        }
      />
      <SettingRow
        label=""
        control={
          <Button
            size="sm"
            disabled={
              save.isPending ||
              !Number.isFinite(timeoutMs) ||
              !Number.isFinite(maxBytes) ||
              !Number.isFinite(maxCharacters)
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save"}
          </Button>
        }
      />
    </SettingsSection>
  );
}
