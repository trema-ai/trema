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
import { Textarea } from "#web/components/ui/textarea.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import { ProviderLogo } from "#web/pages/settings/models/provider-logo.tsx";
import {
  allowedCredentialModes,
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
  onCreated: () => void;
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
  const [region, setRegion] = useState("");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("");
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [keyFile, setKeyFile] = useState("");

  function clearSecrets() {
    setCredential("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
    setKeyFile("");
  }

  useEffect(() => {
    if (open) return;
    setChosen(undefined);
    setCredential("");
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
    setKeyFile("");
  }, [open]);

  function choose(preset: ModelProviderPreset) {
    setChosen(preset);
    setName(suggestName(preset.name, existingNames));
    setLabel(preset.label);
    setProtocol(preset.protocol);
    setBaseUrl(preset.baseUrl);
    setCredentialMode(preset.credentialMode);
    // Seeded like the base URL, and edited in the same form: the protocols that
    // take no settings leave these empty and never show the fields.
    setRegion(preset.settings?.region ?? "");
    setProject(preset.settings?.project ?? "");
    setLocation(preset.settings?.location ?? "");
    clearSecrets();
  }

  // Two protocols take settings, and each needs its own; two credential modes
  // ask for something other than one key. All of it is read off the form rather
  // than the preset, because the admin can change any of it before saving.
  const needsRegion = protocol === "bedrock";
  const needsProject = protocol === "vertex";
  const signing = credentialMode === "aws_sigv4";
  const signingKeys = accessKeyId.trim() !== "" && secretAccessKey.trim() !== "";
  const serviceAccount = credentialMode === "gcp_adc";
  // Half a key pair is not a choice to sign with the server's own role, it is a
  // typo — and sending it as none at all would store a provider the admin
  // believes holds their keys. Saying so beats guessing which half was meant.
  const signingPartial =
    signing &&
    !signingKeys &&
    (accessKeyId.trim() !== "" || secretAccessKey.trim() !== "" || sessionToken.trim() !== "");

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
        credential: signing
          ? // A signing provider with no stored keys signs with the role the
            // server itself runs under, so leaving these blank is a choice and
            // not an omission.
            signingKeys
            ? JSON.stringify({
                accessKeyId: accessKeyId.trim(),
                secretAccessKey: secretAccessKey.trim(),
                ...(sessionToken.trim() === "" ? {} : { sessionToken: sessionToken.trim() }),
              })
            : null
          : serviceAccount
            ? // A provider with no stored service account mints its tokens from
              // the credential the server itself can reach, so leaving this
              // blank is a choice and not an omission. What goes over is the
              // key file as downloaded; the registry keeps the two fields of it
              // that a token exchange spends.
              keyFile.trim() === ""
              ? null
              : keyFile.trim()
            : credentialMode === "api_key"
              ? credential
              : null,
        // Sent only where the protocol takes it: every other protocol refuses
        // a value outright.
        settings: needsRegion
          ? { region: region.trim() }
          : needsProject
            ? { project: project.trim(), location: location.trim() }
            : null,
        // Carried from the preset, never typed: it is how a provider whose
        // model list filters itself answers in full.
        listQuery: chosen?.listQuery ?? null,
      }),
    onSuccess: (provider) => {
      toast.success(`${provider.label} added`);
      onCreated();
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (taken || signingPartial) return;
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
                A preset fills in the endpoint and the credential mode, both editable afterwards.
                The models are read from the provider itself as it is added.
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
                    onValueChange={(value) => {
                      const chosenProtocol = value as ModelProtocol;
                      setProtocol(chosenProtocol);
                      // A protocol and a credential mode are one decision, and
                      // the registry refuses a pair it cannot spend. So a mode
                      // the new protocol does not take snaps to its default
                      // here rather than waiting to be refused on save.
                      const allowed = allowedCredentialModes(chosenProtocol);
                      if (!allowed.includes(credentialMode)) {
                        setCredentialMode(allowed[0]);
                        clearSecrets();
                      }
                    }}
                  >
                    <SelectTrigger id="provider-protocol" className="w-full">
                      <SelectValue />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value="openai_compatible">
                        {protocolLabel("openai_compatible")}
                      </SelectItem>
                      <SelectItem value="openai_responses">
                        {protocolLabel("openai_responses")}
                      </SelectItem>
                      <SelectItem value="anthropic">{protocolLabel("anthropic")}</SelectItem>
                      <SelectItem value="google">{protocolLabel("google")}</SelectItem>
                      <SelectItem value="bedrock">{protocolLabel("bedrock")}</SelectItem>
                      <SelectItem value="vertex">{protocolLabel("vertex")}</SelectItem>
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
                      {/* Only what the chosen protocol takes: a pair the registry
                          refuses is not an option worth offering. */}
                      {allowedCredentialModes(protocol).map((mode) => (
                        <SelectItem key={mode} value={mode}>
                          {credentialModeLabel(mode)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              {needsRegion ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-region">Region</Label>
                  <Input
                    id="provider-region"
                    value={region}
                    required
                    placeholder="us-east-1"
                    onChange={(event) => setRegion(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    Every request is signed for this region, whichever host answers it.
                  </p>
                </div>
              ) : null}
              {needsProject ? (
                <div className="grid gap-4 sm:grid-cols-2">
                  <div className="space-y-2">
                    <Label htmlFor="provider-project">Project</Label>
                    <Input
                      id="provider-project"
                      value={project}
                      required
                      placeholder="my-project-id"
                      onChange={(event) => setProject(event.target.value)}
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="provider-location">Location</Label>
                    <Input
                      id="provider-location"
                      value={location}
                      required
                      placeholder="us-central1"
                      onChange={(event) => setLocation(event.target.value)}
                    />
                  </div>
                  <p className="text-meta text-muted-foreground sm:col-span-2">
                    Vertex addresses a model under both, and the address above carries neither.
                  </p>
                </div>
              ) : null}
              {signing ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-access-key-id">Access key ID</Label>
                  <Input
                    id="provider-access-key-id"
                    autoComplete="off"
                    placeholder="AKIA…"
                    value={accessKeyId}
                    onChange={(event) => setAccessKeyId(event.target.value)}
                  />
                  <Label htmlFor="provider-secret-access-key">Secret access key</Label>
                  <Input
                    id="provider-secret-access-key"
                    type="password"
                    autoComplete="new-password"
                    value={secretAccessKey}
                    onChange={(event) => setSecretAccessKey(event.target.value)}
                  />
                  <Label htmlFor="provider-session-token">Session token</Label>
                  <Input
                    id="provider-session-token"
                    type="password"
                    autoComplete="new-password"
                    placeholder="Only for temporary credentials"
                    value={sessionToken}
                    onChange={(event) => setSessionToken(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    Stored encrypted and write-only. Left blank, requests are signed with the
                    credentials the server itself runs with, and the model list stays empty until
                    keys are entered here.
                  </p>
                  {signingPartial ? (
                    <p className="text-meta text-destructive">
                      Enter both the access key ID and the secret access key, or leave every field
                      blank to sign with the server's own role.
                    </p>
                  ) : null}
                </div>
              ) : null}
              {serviceAccount ? (
                <div className="space-y-2">
                  <Label htmlFor="provider-key-file">Service-account key file</Label>
                  <Textarea
                    id="provider-key-file"
                    rows={4}
                    autoComplete="off"
                    spellCheck={false}
                    placeholder={'{ "type": "service_account", "client_email": … }'}
                    value={keyFile}
                    onChange={(event) => setKeyFile(event.target.value)}
                  />
                  <p className="text-meta text-muted-foreground">
                    Paste the JSON key file as downloaded. Stored encrypted and write-only, down to
                    the two fields a token is minted from. Left blank, tokens are minted from the
                    credentials the server itself runs with, and the model list stays empty until a
                    key file is entered here.
                  </p>
                </div>
              ) : null}
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
                Adding it reads the provider's model list, so its models are in the list below ready
                to assign. A provider that does not answer is still added.
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={() => setChosen(undefined)}>
                <ChevronLeft />
                Presets
              </Button>
              <Button disabled={taken || signingPartial || create.isPending}>
                {create.isPending ? "Adding…" : "Add"}
              </Button>
            </DialogFooter>
          </form>
        )}
      </DialogContent>
    </Dialog>
  );
}
