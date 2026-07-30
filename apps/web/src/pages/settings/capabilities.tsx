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
type DriverKey = "brave_search" | "tavily_search";

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
            drivers={driverRows.filter((driver) => driver.capabilities.includes("web.search"))}
            providers={providerRows.filter((provider) =>
              provider.capabilities.includes("web.search"),
            )}
            route={routeRows.find((route) => route.capabilityKey === "web.search")}
            onChanged={invalidate}
          />
          <WebFetchSection
            providers={providerRows.filter((provider) =>
              provider.capabilities.includes("web.fetch"),
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
      <WebRouteRow
        capabilityKey="web.search"
        providers={providers}
        route={route}
        onChanged={onChanged}
      />
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

function WebRouteRow({
  capabilityKey,
  providers,
  route,
  onChanged,
}: {
  capabilityKey: CapabilityKey;
  providers: CapabilityProvider[];
  route: CapabilityRoute | undefined;
  onChanged: () => Promise<void>;
}) {
  const label = capabilityKey === "web.search" ? "Web search" : "Web fetch";
  const providerKind = capabilityKey === "web.search" ? "search" : "fetch";
  const configured = providers.filter((provider) => provider.hasCredential);
  const defaultProviderName = configured[0]?.name ?? "";
  const [enabled, setEnabled] = useState(route !== undefined);
  const [primary, setPrimary] = useState(route?.chain[0] ?? defaultProviderName);
  const [fallback, setFallback] = useState(route?.chain[1] ?? "none");
  useEffect(() => {
    setEnabled(route !== undefined);
    setPrimary(route?.chain[0] ?? defaultProviderName);
    setFallback(route?.chain[1] ?? "none");
  }, [route, defaultProviderName]);
  const save = useMutation({
    mutationFn: () =>
      rpcClient.capabilities.routes.put({
        capabilityKey,
        chain: enabled
          ? [primary, ...(fallback === "none" || fallback === primary ? [] : [fallback])]
          : [],
      }),
    onSuccess: async () => {
      await onChanged();
      toast.success(enabled ? `${label} route saved` : `${label} disabled`);
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
              aria-label={`Enable ${label.toLowerCase()}`}
              checked={enabled}
              disabled={configured.length === 0}
              onCheckedChange={setEnabled}
            />
            <span className="text-chrome">{enabled ? "Enabled" : "Disabled"}</span>
          </div>
          {configured.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              Configure at least one {providerKind} provider to enable this capability.
            </p>
          ) : enabled ? (
            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <Label>Primary</Label>
                <Select value={primary} onValueChange={setPrimary}>
                  <SelectTrigger
                    className="mt-2 w-full"
                    aria-label={`Primary ${providerKind} provider`}
                  >
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
                  <SelectTrigger
                    className="mt-2 w-full"
                    aria-label={`Fallback ${providerKind} provider`}
                  >
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

function WebFetchSection({
  providers,
  route,
  onChanged,
}: {
  providers: CapabilityProvider[];
  route: CapabilityRoute | undefined;
  onChanged: () => Promise<void>;
}) {
  return (
    <SettingsSection
      title="Web fetch"
      description="Fetch providers extract a page into one normalized, bounded text result."
    >
      <WebRouteRow
        capabilityKey="web.fetch"
        providers={providers}
        route={route}
        onChanged={onChanged}
      />
    </SettingsSection>
  );
}
