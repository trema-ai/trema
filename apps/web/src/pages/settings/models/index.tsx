import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowDown, ArrowUp, Boxes, Plus, X } from "lucide-react";
import { useEffect, useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";

import { CredentialStatusBadge } from "#web/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#web/components/ui/select.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { CreateProviderDialog } from "#web/pages/settings/models/create-dialog.tsx";
import { ProviderLogo } from "#web/pages/settings/models/provider-logo.tsx";
import {
  type ChainEntry,
  credentialModeLabel,
  type ModelProvider,
  messageFrom,
  modelDisplayName,
  type ProbeResult,
  protocolLabel,
  type RoleDefault,
  roleDescriptions,
  servesRole,
} from "#web/pages/settings/models/shared.tsx";

export function SettingsModelsPage() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const providers = useQuery(orpc.modelProviders.providers.list.queryOptions({}));
  const defaults = useQuery(orpc.modelProviders.defaults.list.queryOptions({}));
  const [adding, setAdding] = useState(false);
  const providerRows = (providers.data ?? []) as ModelProvider[];
  const defaultRows = (defaults.data ?? []) as RoleDefault[];
  const error = providers.error ?? defaults.error;
  const pending = providers.isPending || defaults.isPending;

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.providers.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.defaults.list.key() }),
    ]);
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Models"
        description="The providers this organization can call, and which model serves each role."
        actions={
          <Button onClick={() => setAdding(true)}>
            <Plus />
            Add provider
          </Button>
        }
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error.message}</AlertDescription>
        </Alert>
      ) : null}
      {pending ? (
        <div className="space-y-4">
          {[1, 2].map((key) => (
            <div key={key} className="h-40 animate-pulse rounded-lg border bg-muted/30" />
          ))}
        </div>
      ) : (
        <div className="space-y-7">
          <section data-slot="settings-section">
            <h3 className="text-chrome font-medium text-foreground">Providers</h3>
            <p className="mt-0.5 text-meta text-muted-foreground">
              Each provider is an endpoint plus its credential. The credential stays on the server.
            </p>
            <div className="mt-2 divide-y rounded-md border bg-card">
              {providerRows.length === 0 ? (
                <EmptyState
                  icon={Boxes}
                  title="No providers yet"
                  description="Add one to give the agent a model to run on."
                  action={<Button onClick={() => setAdding(true)}>Add provider</Button>}
                />
              ) : (
                providerRows.map((provider) => (
                  <ProviderRow
                    key={provider.name}
                    provider={provider}
                    onOpen={() => navigate(`/settings/models/${provider.name}`)}
                  />
                ))
              )}
            </div>
          </section>
          <section data-slot="settings-section">
            <h3 className="text-chrome font-medium text-foreground">Role assignments</h3>
            <p className="mt-0.5 text-meta text-muted-foreground">
              Each role resolves down its list until a provider answers, so a second entry is a
              fallback.
            </p>
            <div className="mt-2 space-y-3">
              {roleDescriptions.map((role) => (
                <RoleCard
                  key={role.role}
                  role={role}
                  chain={defaultRows.find((entry) => entry.role === role.role)?.chain ?? []}
                  providers={providerRows}
                  onChanged={invalidate}
                />
              ))}
            </div>
          </section>
        </div>
      )}
      <CreateProviderDialog
        open={adding}
        onOpenChange={setAdding}
        existingNames={providerRows.map((provider) => provider.name)}
        onCreated={async (name) => {
          setAdding(false);
          await invalidate();
          navigate(`/settings/models/${name}`);
        }}
      />
    </main>
  );
}

function ProviderRow({ provider, onOpen }: { provider: ModelProvider; onOpen: () => void }) {
  const [result, setResult] = useState<ProbeResult>();
  const probe = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.probe({ name: provider.name }),
    onSuccess: (probed) => setResult(probed),
    onError: (error) => toast.error(messageFrom(error)),
  });
  const summary = [
    provider.name,
    protocolLabel(provider.protocol),
    `${provider.catalog.length} model${provider.catalog.length === 1 ? "" : "s"}`,
  ].join(" · ");
  const keyed = provider.credentialMode === "api_key";
  return (
    <div className="flex flex-wrap items-center justify-between gap-3 px-4 py-3.5">
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        onClick={onOpen}
      >
        <ProviderLogo
          name={provider.name}
          label={provider.label}
          baseUrl={provider.baseUrl}
          className="size-8"
        />
        <span className="min-w-0">
          <span className="block text-chrome font-medium">{provider.label}</span>
          <span className="mt-0.5 block truncate text-meta text-muted-foreground">{summary}</span>
          {result ? (
            <span className="mt-1 block text-meta text-muted-foreground">
              {result.ok
                ? `Answered in ${result.latencyMs} ms${
                    result.modelCount === undefined ? "" : `, listing ${result.modelCount} models`
                  }.`
                : result.reason}
            </span>
          ) : null}
        </span>
      </button>
      <div className="flex items-center gap-2">
        {/* A provider in key mode always has one stored: the registry refuses the other state. */}
        <CredentialStatusBadge
          status="connected"
          label={keyed ? "Key stored" : credentialModeLabel("none")}
        />
        <Button
          size="sm"
          variant="outline"
          disabled={probe.isPending}
          onClick={() => probe.mutate()}
        >
          {probe.isPending ? "Checking…" : "Check"}
        </Button>
      </div>
    </div>
  );
}

function withoutRepeats(chain: ChainEntry[]): ChainEntry[] {
  const seen = new Set<string>();
  return chain.filter((entry) => {
    const key = `${entry.providerName}\u0000${entry.modelId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function RoleCard({
  role,
  chain,
  providers,
  onChanged,
}: {
  role: (typeof roleDescriptions)[number];
  chain: ChainEntry[];
  providers: ModelProvider[];
  onChanged: () => Promise<void>;
}) {
  const [draft, setDraft] = useState<ChainEntry[]>(() => withoutRepeats(chain));
  // A chain written through the API can name the same model twice, where only
  // the first entry can ever be reached. The editor shows the chain that runs.
  const stored = JSON.stringify(withoutRepeats(chain));
  useEffect(() => {
    setDraft(JSON.parse(stored) as ChainEntry[]);
  }, [stored]);
  const dirty = JSON.stringify(draft) !== stored;
  const choices = providers.flatMap((provider) =>
    provider.catalog
      .filter((entry) => servesRole(entry, role.role))
      .map((entry) => ({ provider, entry })),
  );

  const save = useMutation({
    mutationFn: async () => {
      if (draft.length === 0) await rpcClient.modelProviders.defaults.delete({ role: role.role });
      else await rpcClient.modelProviders.defaults.put({ role: role.role, chain: draft });
    },
    onSuccess: async () => {
      await onChanged();
      toast.success(draft.length === 0 ? `${role.label} unassigned` : `${role.label} saved`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function move(index: number, by: number) {
    setDraft((current) => {
      const next = [...current];
      const [entry] = next.splice(index, 1);
      if (entry) next.splice(index + by, 0, entry);
      return next;
    });
  }

  return (
    <div className="rounded-md border bg-card">
      <div className="flex flex-wrap items-start justify-between gap-3 px-4 py-3.5">
        <div className="min-w-0">
          <p className="text-chrome font-medium">{role.label}</p>
          <p className="mt-0.5 text-meta text-muted-foreground">{role.description}</p>
        </div>
        {dirty ? (
          <div className="flex items-center gap-2">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setDraft(JSON.parse(stored) as ChainEntry[])}
            >
              Cancel
            </Button>
            <Button size="sm" disabled={save.isPending} onClick={() => save.mutate()}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        ) : null}
      </div>
      <div className="border-t px-4 py-3">
        {draft.length === 0 ? (
          <p className="text-meta text-muted-foreground">{role.unassigned}</p>
        ) : (
          <ol className="space-y-1.5">
            {draft.map((entry, index) => {
              const provider = providers.find((row) => row.name === entry.providerName);
              const model = provider?.catalog.find((candidate) => candidate.id === entry.modelId);
              return (
                <li
                  key={`${entry.providerName}-${entry.modelId}`}
                  className="flex items-center gap-2"
                >
                  <span className="w-4 shrink-0 text-meta text-muted-foreground">{index + 1}</span>
                  <span className="min-w-0 flex-1 truncate text-chrome">
                    {model ? modelDisplayName(model) : entry.modelId}
                    <span className="text-muted-foreground">
                      {" "}
                      on {provider?.label ?? entry.providerName}
                    </span>
                    {provider ? null : (
                      <span className="text-muted-foreground"> · provider is gone</span>
                    )}
                  </span>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${entry.modelId} up`}
                    disabled={index === 0}
                    onClick={() => move(index, -1)}
                  >
                    <ArrowUp />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Move ${entry.modelId} down`}
                    disabled={index === draft.length - 1}
                    onClick={() => move(index, 1)}
                  >
                    <ArrowDown />
                  </Button>
                  <Button
                    size="icon-xs"
                    variant="ghost"
                    aria-label={`Remove ${entry.modelId}`}
                    onClick={() =>
                      setDraft((current) => current.filter((_, position) => position !== index))
                    }
                  >
                    <X />
                  </Button>
                </li>
              );
            })}
          </ol>
        )}
        <div className="mt-3">
          {choices.length === 0 ? (
            <p className="text-meta text-muted-foreground">
              No provider lists a model for this role yet. Add models on a provider's page.
            </p>
          ) : (
            <Select
              value=""
              onValueChange={(value) => {
                setDraft((current) => [...current, JSON.parse(value) as ChainEntry]);
              }}
            >
              <SelectTrigger size="sm" aria-label={`Add a model to ${role.label}`}>
                <SelectValue placeholder="Add a model" />
              </SelectTrigger>
              <SelectContent>
                {choices
                  .filter(
                    ({ provider, entry }) =>
                      !draft.some(
                        (existing) =>
                          existing.providerName === provider.name && existing.modelId === entry.id,
                      ),
                  )
                  .map(({ provider, entry }) => (
                    <SelectItem
                      key={`${provider.name}-${entry.id}`}
                      value={JSON.stringify({ providerName: provider.name, modelId: entry.id })}
                    >
                      {modelDisplayName(entry)} on {provider.label}
                    </SelectItem>
                  ))}
              </SelectContent>
            </Select>
          )}
        </div>
      </div>
    </div>
  );
}
