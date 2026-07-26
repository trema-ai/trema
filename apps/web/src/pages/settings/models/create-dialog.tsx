import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronLeft, SlidersHorizontal } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

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
import { orpc, rpcClient } from "#web/lib/api.ts";
import { ProviderLogo } from "#web/pages/settings/models/provider-logo.tsx";
import {
  credentialModeLabel,
  type ModelCredentialMode,
  type ModelProtocol,
  type ModelProviderPreset,
  messageFrom,
  protocolLabel,
} from "#web/pages/settings/models/shared.tsx";

const customPreset: ModelProviderPreset = {
  name: "",
  label: "",
  protocol: "openai_compatible",
  baseUrl: "",
  credentialMode: "api_key",
};

/** Keeps a suggested name unique without making the admin discover the clash. */
function suggestName(preset: string, taken: string[]) {
  if (!preset || !taken.includes(preset)) return preset;
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${preset}-${suffix}`;
    if (!taken.includes(candidate)) return candidate;
  }
}

export function CreateProviderDialog({
  open,
  onOpenChange,
  existingNames,
  onCreated,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  existingNames: string[];
  onCreated: (name: string) => void;
}) {
  const presets = useQuery(orpc.modelProviders.presets.list.queryOptions({}));
  const presetRows = (presets.data ?? []) as ModelProviderPreset[];
  const [chosen, setChosen] = useState<ModelProviderPreset>();
  const [name, setName] = useState("");
  const [label, setLabel] = useState("");
  const [protocol, setProtocol] = useState<ModelProtocol>("openai_compatible");
  const [baseUrl, setBaseUrl] = useState("");
  const [credentialMode, setCredentialMode] = useState<ModelCredentialMode>("api_key");
  const [credential, setCredential] = useState("");

  useEffect(() => {
    if (open) return;
    setChosen(undefined);
    setCredential("");
  }, [open]);

  function choose(preset: ModelProviderPreset) {
    setChosen(preset);
    setName(suggestName(preset.name, existingNames));
    setLabel(preset.label);
    setProtocol(preset.protocol);
    setBaseUrl(preset.baseUrl);
    setCredentialMode(preset.credentialMode);
    setCredential("");
  }

  // The server refuses a name already in the registry; this only says so before
  // the round trip, and cannot be the guarantee — two admins can race it.
  const taken = existingNames.includes(name.trim());

  const create = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.create({
        name: name.trim(),
        label: label.trim() || name.trim(),
        protocol,
        baseUrl: baseUrl.trim(),
        credentialMode,
        credential: credentialMode === "api_key" ? credential : null,
      }),
    onSuccess: (provider) => {
      toast.success(`${provider.label} added`);
      onCreated(provider.name);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (taken) return;
    create.mutate();
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        {chosen === undefined ? (
          <>
            <DialogHeader>
              <DialogTitle>Add a model provider</DialogTitle>
              <DialogDescription>
                A preset fills in the endpoint, the credential mode, and a starting model list. All
                of it stays editable afterwards.
              </DialogDescription>
            </DialogHeader>
            <div className="grid gap-2 sm:grid-cols-2">
              {presetRows.map((preset) => (
                <button
                  key={preset.name}
                  type="button"
                  className="flex items-center gap-2.5 rounded-md border bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                  onClick={() => choose(preset)}
                >
                  <ProviderLogo
                    icon={preset.icon}
                    name={preset.name}
                    label={preset.label}
                    baseUrl={preset.baseUrl}
                    className="size-8"
                  />
                  <span className="min-w-0">
                    <span className="block text-chrome font-medium">{preset.label}</span>
                    <span className="mt-0.5 block truncate text-meta text-muted-foreground">
                      {preset.baseUrl}
                    </span>
                  </span>
                </button>
              ))}
              <button
                type="button"
                className="rounded-md border border-dashed bg-card px-3 py-2.5 text-left transition-colors hover:bg-muted/50"
                onClick={() => {
                  choose(customPreset);
                  setName("");
                }}
              >
                <span className="flex items-center gap-2 text-chrome font-medium">
                  <SlidersHorizontal className="size-4 text-muted-foreground" aria-hidden="true" />
                  Custom
                </span>
                <span className="mt-0.5 block text-meta text-muted-foreground">
                  Enter the endpoint yourself.
                </span>
              </button>
            </div>
            {presets.error ? (
              <p className="text-meta text-destructive">{presets.error.message}</p>
            ) : null}
          </>
        ) : (
          <form onSubmit={submit}>
            <DialogHeader>
              <DialogTitle>{chosen.label || "Custom provider"}</DialogTitle>
              <DialogDescription>
                The name is what role assignments reference. The credential is stored encrypted and
                never shown again.
              </DialogDescription>
            </DialogHeader>
            <div className="my-5 space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="provider-name">Name</Label>
                  <Input
                    id="provider-name"
                    value={name}
                    required
                    autoFocus
                    aria-invalid={taken}
                    aria-describedby={taken ? "provider-name-taken" : undefined}
                    onChange={(event) => setName(event.target.value)}
                  />
                  {taken ? (
                    <p id="provider-name-taken" className="text-meta text-destructive">
                      A provider is already stored under this name. Open it to edit it, or pick
                      another name.
                    </p>
                  ) : null}
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-label">Display name</Label>
                  <Input
                    id="provider-label"
                    value={label}
                    placeholder={name}
                    onChange={(event) => setLabel(event.target.value)}
                  />
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="provider-base-url">Base URL</Label>
                <Input
                  id="provider-base-url"
                  value={baseUrl}
                  required
                  placeholder="https://api.example.com/v1"
                  onChange={(event) => setBaseUrl(event.target.value)}
                />
                <p className="text-meta text-muted-foreground">
                  Include the version path, the way the provider documents it.
                </p>
              </div>
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="provider-protocol">Protocol</Label>
                  <Select
                    value={protocol}
                    onValueChange={(value) => setProtocol(value as ModelProtocol)}
                  >
                    <SelectTrigger id="provider-protocol" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai_compatible">
                        {protocolLabel("openai_compatible")}
                      </SelectItem>
                    </SelectContent>
                  </Select>
                </div>
                <div className="space-y-2">
                  <Label htmlFor="provider-credential-mode">Authentication</Label>
                  <Select
                    value={credentialMode}
                    onValueChange={(value) => setCredentialMode(value as ModelCredentialMode)}
                  >
                    <SelectTrigger id="provider-credential-mode" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="api_key">{credentialModeLabel("api_key")}</SelectItem>
                      <SelectItem value="none">{credentialModeLabel("none")}</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {credentialMode === "api_key" ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-credential">API key</Label>
                  <Input
                    id="provider-credential"
                    type="password"
                    required
                    autoComplete="new-password"
                    value={credential}
                    onChange={(event) => setCredential(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    Stored encrypted and write-only; it cannot be viewed later.
                  </p>
                </div>
              ) : null}
              <p className="text-meta text-muted-foreground">
                Adding it opens the provider page, where its models are read from the provider and
                picked.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setChosen(undefined)}>
                <ChevronLeft />
                Presets
              </Button>
              <Button disabled={taken || create.isPending}>
                {create.isPending ? "Adding…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
