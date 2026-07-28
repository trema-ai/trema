import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Boxes, Plus, RefreshCw, Trash2, X } from "lucide-react";
import { type FormEvent, useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router";
import { toast } from "sonner";

import { CredentialStatusBadge } from "#web/components/trema/credential-status-badge.tsx";
import { EmptyState } from "#web/components/trema/empty-state.tsx";
import { PageHeader } from "#web/components/trema/page-header.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
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
  type CatalogRefresh,
  credentialModeLabel,
  descriptorOf,
  type ModelProtocol,
  type ModelProvider,
  messageFrom,
  type ProbeResult,
  protocolLabel,
} from "#web/pages/settings/models/shared.tsx";

export function SettingsModelProviderPage() {
  const { providerName = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const query = useQuery(
    orpc.modelProviders.providers.get.queryOptions({ input: { name: providerName } }),
  );
  const provider = query.data as ModelProvider | undefined;

  async function invalidate() {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.providers.get.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.providers.list.key() }),
      queryClient.invalidateQueries({ queryKey: orpc.modelProviders.defaults.list.key() }),
    ]);
  }

  if (query.isPending) {
    return (
      <main className="mx-auto w-full max-w-5xl space-y-4 p-4 sm:p-6 lg:p-8">
        <div className="h-16 animate-pulse rounded-lg bg-muted/50" />
        {[1, 2, 3].map((key) => (
          <div key={key} className="h-40 animate-pulse rounded-lg border bg-muted/30" />
        ))}
      </main>
    );
  }
  if (query.error) {
    return (
      <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
        <Alert variant="destructive">
          <AlertDescription>{query.error.message}</AlertDescription>
        </Alert>
      </main>
    );
  }
  if (!provider) {
    return (
      <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
        <EmptyState
          icon={Boxes}
          title="Provider not found"
          description="No provider by this name is in the registry."
          action={<Button onClick={() => navigate("/settings/models")}>Back to models</Button>}
        />
      </main>
    );
  }

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        leading={
          <ProviderLogo
            name={provider.name}
            label={provider.label}
            baseUrl={provider.baseUrl}
            className="size-10"
          />
        }
        title={provider.label}
        description={
          <>
            {provider.name} · {protocolLabel(provider.protocol)} · updated{" "}
            <RelativeTime date={provider.updatedAt} />
          </>
        }
      />
      <div className="space-y-7">
        <EndpointSection provider={provider} onChanged={invalidate} />
        {provider.credentialMode === "aws_sigv4" ? (
          <SigningCredentialSection provider={provider} onChanged={invalidate} />
        ) : provider.credentialMode === "gcp_adc" ? (
          <ServiceAccountCredentialSection provider={provider} onChanged={invalidate} />
        ) : (
          <CredentialSection provider={provider} onChanged={invalidate} />
        )}
        <HeadersSection provider={provider} onChanged={invalidate} />
        <ModelsSection provider={provider} onChanged={invalidate} />
        <DangerZone
          provider={provider}
          onDeleted={async () => {
            await invalidate();
            navigate("/settings/models");
          }}
        />
      </div>
    </main>
  );
}

function EndpointSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [label, setLabel] = useState(provider.label);
  const [baseUrl, setBaseUrl] = useState(provider.baseUrl);
  const [protocol, setProtocol] = useState<ModelProtocol>(provider.protocol);
  const storedRegion = provider.settings?.region ?? "";
  const storedProject = provider.settings?.project ?? "";
  const storedLocation = provider.settings?.location ?? "";
  const [region, setRegion] = useState(storedRegion);
  const [project, setProject] = useState(storedProject);
  const [location, setLocation] = useState(storedLocation);
  useEffect(() => {
    setLabel(provider.label);
    setBaseUrl(provider.baseUrl);
    setProtocol(provider.protocol);
    setRegion(storedRegion);
    setProject(storedProject);
    setLocation(storedLocation);
  }, [
    provider.label,
    provider.baseUrl,
    provider.protocol,
    storedRegion,
    storedProject,
    storedLocation,
  ]);
  // Two protocols take settings, and each needs its own: a row that switches to
  // one cannot be saved until its fields are filled in.
  const needsRegion = protocol === "bedrock";
  const needsProject = protocol === "vertex";
  const settingsIncomplete =
    (needsRegion && region.trim() === "") ||
    (needsProject && (project.trim() === "" || location.trim() === ""));
  // The mode this save sends. The registry takes a protocol and a credential
  // mode as one decision and refuses a pair it cannot spend, so carrying the
  // stored mode across a protocol switch would be a dead end. Where the chosen
  // protocol cannot take it: a signing protocol lands in its own mode, whose
  // credential this form drops — which leaves the row signing with the server's
  // own credentials, a supported state; and a protocol that authenticates with
  // a key lands in `none` rather than `api_key`, because a key is a value this
  // form has no field for and the credential section below is where it goes.
  const allowedModes = allowedCredentialModes(protocol);
  const credentialMode = allowedModes.includes(provider.credentialMode)
    ? provider.credentialMode
    : allowedModes.includes("none")
      ? "none"
      : allowedModes[0];
  const credentialDropped = credentialMode !== provider.credentialMode;
  const dirty =
    label !== provider.label ||
    baseUrl !== provider.baseUrl ||
    protocol !== provider.protocol ||
    (needsRegion && region.trim() !== storedRegion) ||
    (needsProject && (project.trim() !== storedProject || location.trim() !== storedLocation));
  const save = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        label: label.trim() || provider.name,
        baseUrl: baseUrl.trim(),
        protocol,
        credentialMode,
        // A credential belongs to the mode that wrote it, and the registry
        // refuses one kept across a change of shape, so dropping it is stated
        // here rather than left to fail.
        ...(credentialDropped ? { credential: null } : {}),
        // Sent only where the protocol takes it, and cleared where it does not:
        // every other protocol refuses a value outright.
        settings: needsRegion
          ? { region: region.trim() }
          : needsProject
            ? { project: project.trim(), location: location.trim() }
            : null,
      }),
    onSuccess: async () => {
      await onChanged();
      toast.success("Endpoint saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    save.mutate();
  }

  return (
    <form onSubmit={submit}>
      <SettingsSection title="Endpoint">
        <SettingRow
          label="Display name"
          orientation="stack"
          control={
            <Input
              aria-label="Display name"
              value={label}
              onChange={(event) => setLabel(event.target.value)}
            />
          }
        />
        <SettingRow
          label="Base URL"
          description="Include the version path, the way the provider documents it."
          orientation="stack"
          control={
            <Input
              aria-label="Base URL"
              value={baseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
            />
          }
        />
        <SettingRow
          label="Protocol"
          control={
            <Select value={protocol} onValueChange={(value) => setProtocol(value as ModelProtocol)}>
              <SelectTrigger aria-label="Protocol" className="w-56">
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
          }
        />
        {credentialDropped ? (
          <SettingRow
            label=""
            orientation="stack"
            control={
              <p className="text-meta text-destructive">
                Saving switches authentication to {credentialModeLabel(credentialMode)}, which is
                what {protocolLabel(protocol)} takes
                {provider.hasCredential ? ", and drops the stored credential" : ""}. The credential
                section below takes the new one.
              </p>
            }
          />
        ) : null}
        {needsRegion ? (
          <SettingRow
            label="Region"
            description="Every request is signed for this region, whichever host answers it. A VPC endpoint or a gateway does not carry one to read."
            orientation="stack"
            control={
              <Input
                aria-label="Region"
                className="max-w-sm"
                placeholder="us-east-1"
                value={region}
                onChange={(event) => setRegion(event.target.value)}
              />
            }
          />
        ) : null}
        {needsProject ? (
          <>
            <SettingRow
              label="Project"
              description="The Google Cloud project the models are addressed under, and whose quota they spend."
              orientation="stack"
              control={
                <Input
                  aria-label="Project"
                  className="max-w-sm"
                  placeholder="my-project-id"
                  value={project}
                  onChange={(event) => setProject(event.target.value)}
                />
              }
            />
            <SettingRow
              label="Location"
              description="The Vertex location the models are addressed in. The address above names the API surface, not the resource path under it."
              orientation="stack"
              control={
                <Input
                  aria-label="Location"
                  className="max-w-sm"
                  placeholder="us-central1"
                  value={location}
                  onChange={(event) => setLocation(event.target.value)}
                />
              }
            />
          </>
        ) : null}
        <SettingRow
          label=""
          control={
            <Button disabled={!dirty || save.isPending || settingsIncomplete}>
              {save.isPending ? "Saving…" : "Save"}
            </Button>
          }
        />
      </SettingsSection>
    </form>
  );
}

/**
 * The one cheap authenticated call, on demand. Shared by every credential
 * section because the question it answers is the same whatever the mode: does
 * this provider answer, and does it accept what is stored.
 */
function HealthCheckRow({ provider }: { provider: ModelProvider }) {
  const [result, setResult] = useState<ProbeResult>();
  const probe = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.probe({ name: provider.name }),
    onSuccess: (probed) => setResult(probed),
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <SettingRow
      label="Health check"
      description={
        result
          ? result.ok
            ? `Answered in ${result.latencyMs} ms${
                result.modelCount === undefined ? "" : `, listing ${result.modelCount} models`
              }.`
            : result.reason
          : ""
      }
      control={
        <Button variant="outline" disabled={probe.isPending} onClick={() => probe.mutate()}>
          {probe.isPending ? "Checking…" : "Check now"}
        </Button>
      }
    />
  );
}

/**
 * Credential entry for the signing mode, where the credential is three fields
 * rather than one. They compose the JSON object the registry stores, so the
 * screen never asks an admin to type JSON, and no field is ever read back.
 *
 * Removing the keys is not the same as removing authentication: a row with no
 * stored keys signs with the role the server itself runs under, which is a
 * supported configuration and the reason this section says so out loud.
 */
function SigningCredentialSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [accessKeyId, setAccessKeyId] = useState("");
  const [secretAccessKey, setSecretAccessKey] = useState("");
  const [sessionToken, setSessionToken] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  function clear() {
    setAccessKeyId("");
    setSecretAccessKey("");
    setSessionToken("");
  }

  const store = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "aws_sigv4",
        credential: JSON.stringify({
          accessKeyId: accessKeyId.trim(),
          secretAccessKey: secretAccessKey.trim(),
          ...(sessionToken.trim() === "" ? {} : { sessionToken: sessionToken.trim() }),
        }),
      }),
    onSuccess: async () => {
      await onChanged();
      clear();
      toast.success("Keys saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const drop = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "aws_sigv4",
        credential: null,
      }),
    onSuccess: async () => {
      await onChanged();
      setConfirmRemove(false);
      toast.success("Keys removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  const incomplete = accessKeyId.trim() === "" || secretAccessKey.trim() === "";
  return (
    <SettingsSection title="Credential">
      <SettingRow
        label="Authentication"
        description="Requests are signed, so no key travels with them."
        control={
          <div className="flex items-center gap-3">
            <CredentialStatusBadge
              status={provider.hasCredential ? "connected" : "missing"}
              label={provider.hasCredential ? "Keys stored" : "Using the server's own role"}
            />
            {provider.hasCredential ? (
              <Button variant="outline" onClick={() => setConfirmRemove(true)}>
                Remove keys
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingRow
        label={provider.hasCredential ? "Replace the keys" : "Store keys"}
        description={
          provider.hasCredential
            ? "Stored keys are never read back, only replaced. Enter every field again."
            : "Without stored keys, requests are signed with the credentials the server itself runs with. Reading the model list needs keys of its own."
        }
        orientation="stack"
        control={
          <div className="max-w-sm space-y-2">
            <Input
              aria-label="Access key ID"
              autoComplete="off"
              placeholder="AKIA…"
              value={accessKeyId}
              onChange={(event) => setAccessKeyId(event.target.value)}
            />
            <Input
              type="password"
              aria-label="Secret access key"
              autoComplete="new-password"
              value={secretAccessKey}
              onChange={(event) => setSecretAccessKey(event.target.value)}
            />
            <Input
              type="password"
              aria-label="Session token"
              autoComplete="new-password"
              placeholder="Session token, for temporary credentials"
              value={sessionToken}
              onChange={(event) => setSessionToken(event.target.value)}
            />
            <Button disabled={incomplete || store.isPending} onClick={() => store.mutate()}>
              {store.isPending ? "Saving…" : "Save keys"}
            </Button>
          </div>
        }
      />
      <HealthCheckRow provider={provider} />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the stored keys?</AlertDialogTitle>
            <AlertDialogDescription>
              The keys are discarded and requests are signed with whatever credentials the server
              itself runs with. Where there are none, every call to this provider fails. The model
              list stops loading either way, because reading it spends this provider's own keys.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={drop.isPending}
              onClick={() => drop.mutate()}
            >
              {drop.isPending ? "Removing…" : "Remove keys"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

/**
 * Credential entry for the Google mode, where the credential is a file rather
 * than a field. What an admin has is the key file the console downloaded, so
 * that is what this asks for: the registry keeps the two fields of it a token
 * exchange spends and discards the rest, which beats making anybody edit JSON
 * down to a pair by hand. Nothing is ever read back.
 *
 * Removing it is not the same as removing authentication: a row with no stored
 * key file mints its tokens from whatever credential the server itself can
 * reach, which is a supported configuration and the reason this section says so
 * out loud.
 */
function ServiceAccountCredentialSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [keyFile, setKeyFile] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  const store = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "gcp_adc",
        credential: keyFile.trim(),
      }),
    onSuccess: async () => {
      await onChanged();
      setKeyFile("");
      toast.success("Service account saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const drop = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "gcp_adc",
        credential: null,
      }),
    onSuccess: async () => {
      await onChanged();
      setConfirmRemove(false);
      toast.success("Service account removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <SettingsSection title="Credential">
      <SettingRow
        label="Authentication"
        description="Each request carries a token minted for it, so no key travels with one."
        control={
          <div className="flex items-center gap-3">
            <CredentialStatusBadge
              status={provider.hasCredential ? "connected" : "missing"}
              label={
                provider.hasCredential
                  ? "Service account stored"
                  : "Using the server's own credentials"
              }
            />
            {provider.hasCredential ? (
              <Button variant="outline" onClick={() => setConfirmRemove(true)}>
                Remove service account
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingRow
        label={provider.hasCredential ? "Replace the service account" : "Store a service account"}
        description={
          provider.hasCredential
            ? "A stored service account is never read back, only replaced. Paste the JSON key file as downloaded."
            : "Without one, tokens are minted from the credentials the server itself runs with. Reading the model list needs a service account of its own."
        }
        orientation="stack"
        control={
          <div className="max-w-sm space-y-2">
            <Textarea
              aria-label="Service-account key file"
              rows={4}
              autoComplete="off"
              spellCheck={false}
              placeholder={'{ "type": "service_account", "client_email": … }'}
              value={keyFile}
              onChange={(event) => setKeyFile(event.target.value)}
            />
            <Button
              disabled={keyFile.trim() === "" || store.isPending}
              onClick={() => store.mutate()}
            >
              {store.isPending ? "Saving…" : "Save service account"}
            </Button>
          </div>
        }
      />
      <HealthCheckRow provider={provider} />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the stored service account?</AlertDialogTitle>
            <AlertDialogDescription>
              The key file is discarded and tokens are minted from whatever credentials the server
              itself can reach. Where there are none, every call to this provider fails. The model
              list stops loading either way, because reading it spends this provider's own service
              account.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={drop.isPending}
              onClick={() => drop.mutate()}
            >
              {drop.isPending ? "Removing…" : "Remove service account"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function CredentialSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [credential, setCredential] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Both writes carry the mode with the value: a provider in key mode with no
  // key is a state the registry refuses, so the screen never proposes it.
  const store = useMutation({
    mutationFn: (value: string) =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "api_key",
        credential: value,
      }),
    onSuccess: async () => {
      await onChanged();
      setCredential("");
      toast.success("Key saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const drop = useMutation({
    mutationFn: () =>
      rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        credentialMode: "none",
        credential: null,
      }),
    onSuccess: async () => {
      await onChanged();
      setConfirmRemove(false);
      toast.success("Credential removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  const keyed = provider.credentialMode === "api_key";
  return (
    <SettingsSection title="Credential">
      <SettingRow
        label="Authentication"
        description={
          keyed
            ? "Requests carry a bearer key."
            : "Requests go unauthenticated suitable for an endpoint on a trusted network."
        }
        control={
          <div className="flex items-center gap-3">
            {/* A provider in key mode always has one stored: the registry refuses the other state. */}
            <CredentialStatusBadge
              status="connected"
              label={keyed ? "Key stored" : credentialModeLabel("none")}
            />
            {keyed ? (
              <Button variant="outline" onClick={() => setConfirmRemove(true)}>
                Remove credential
              </Button>
            ) : null}
          </div>
        }
      />
      <SettingRow
        label={keyed ? "Replace the API key" : "Switch to an API key"}
        description={
          keyed
            ? "A stored key is never read back, only replaced."
            : "Entering a key turns on bearer authentication for every request."
        }
        orientation="stack"
        control={
          <div className="flex flex-wrap items-center gap-2">
            <Input
              type="password"
              aria-label="API key"
              autoComplete="new-password"
              className="max-w-sm"
              value={credential}
              onChange={(event) => setCredential(event.target.value)}
            />
            <Button
              disabled={credential.trim().length === 0 || store.isPending}
              onClick={() => store.mutate(credential.trim())}
            >
              {store.isPending ? "Saving…" : "Save key"}
            </Button>
          </div>
        }
      />
      <HealthCheckRow provider={provider} />
      <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove the stored credential?</AlertDialogTitle>
            <AlertDialogDescription>
              The key is discarded and requests to this provider go unauthenticated. Most providers
              answer that with a 401 until a new key is entered.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={drop.isPending}
              onClick={() => drop.mutate()}
            >
              {drop.isPending ? "Removing…" : "Remove credential"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

function HeadersSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <SettingsSection title="Extra headers">
      <SettingRow
        label={
          provider.headerNames.length === 0 ? "No extra headers" : provider.headerNames.join(", ")
        }
        description={
          provider.headerNames.length === 0
            ? ""
            : "Replacing the set means entering every value again, since the stored ones cannot be read."
        }
        control={
          <Button variant="outline" onClick={() => setEditing(true)}>
            {provider.headerNames.length === 0 ? "Add headers" : "Replace headers"}
          </Button>
        }
      />
      <HeadersDialog
        provider={provider}
        open={editing}
        onOpenChange={setEditing}
        onChanged={onChanged}
      />
    </SettingsSection>
  );
}

function HeadersDialog({
  provider,
  open,
  onOpenChange,
  onChanged,
}: {
  provider: ModelProvider;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onChanged: () => Promise<void>;
}) {
  const [rows, setRows] = useState<{ key: string; name: string; value: string }[]>([]);
  useEffect(() => {
    if (!open) return;
    setRows(
      (provider.headerNames.length === 0 ? [""] : provider.headerNames).map((name) => ({
        key: crypto.randomUUID(),
        name,
        value: "",
      })),
    );
  }, [open, provider.headerNames]);

  const named = rows.filter((row) => row.name.trim().length > 0);
  // Stored values cannot be pre-filled, so a row saved blank would quietly
  // replace a working header with an empty one. Trimmed, because the server
  // trims before storing — spaces-only is blank.
  const missingValue = named.some((row) => row.value.trim().length === 0);
  // Header names are case-insensitive, and the map a save builds keeps the last
  // row of a repeated name — so two rows for one header would silently drop
  // half of what was typed.
  const fields = named.map((row) => row.name.trim().toLowerCase());
  const duplicateName = fields.find((field, index) => fields.indexOf(field) !== index);

  const save = useMutation({
    mutationFn: () => {
      const headers = Object.fromEntries(named.map((row) => [row.name.trim(), row.value]));
      return rpcClient.modelProviders.providers.put({
        ...descriptorOf(provider),
        headers: named.length === 0 ? null : headers,
      });
    },
    onSuccess: async () => {
      await onChanged();
      onOpenChange(false);
      toast.success("Headers saved");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Extra headers</DialogTitle>
          <DialogDescription>
            This replaces the whole set. Every header needs its value typed again, because a stored
            value is never read back. A row left without a name is dropped, and saving with no rows
            removes every header.
          </DialogDescription>
        </DialogHeader>
        <div className="my-4 space-y-2">
          {rows.map((row, index) => (
            <div key={row.key} className="flex items-center gap-2">
              <Input
                aria-label={`Header ${index + 1} name`}
                placeholder="x-tenant"
                value={row.name}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, position) =>
                      position === index ? { ...entry, name: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Input
                aria-label={`Header ${index + 1} value`}
                type="password"
                autoComplete="off"
                placeholder="value"
                value={row.value}
                onChange={(event) =>
                  setRows((current) =>
                    current.map((entry, position) =>
                      position === index ? { ...entry, value: event.target.value } : entry,
                    ),
                  )
                }
              />
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove header ${index + 1}`}
                onClick={() =>
                  setRows((current) => current.filter((_, position) => position !== index))
                }
              >
                <X />
              </Button>
            </div>
          ))}
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() =>
              setRows((current) => [...current, { key: crypto.randomUUID(), name: "", value: "" }])
            }
          >
            <Plus />
            Add header
          </Button>
          {missingValue ? (
            <p className="text-meta text-destructive">
              Enter a value for every header, or remove the row.
            </p>
          ) : null}
          {duplicateName ? (
            <p className="text-meta text-destructive">
              Two rows name the {duplicateName} header. Header names are case-insensitive, so keep
              one of them.
            </p>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            disabled={missingValue || duplicateName !== undefined || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save headers"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ModelsSection({
  provider,
  onChanged,
}: {
  provider: ModelProvider;
  onChanged: () => Promise<void>;
}) {
  const [result, setResult] = useState<CatalogRefresh>();
  // On demand only: providers rate-limit, so nothing reads a model list in the
  // background or on a page view.
  const refresh = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.refreshCatalog({ name: provider.name }),
    onSuccess: async (refreshed) => {
      setResult(refreshed as CatalogRefresh);
      await onChanged();
      if (refreshed.ok) toast.success("Model list read");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const count = provider.catalog.length;

  return (
    <SettingsSection
      title="Models"
      description="Models served by this provider, as of the last refresh."
    >
      <SettingRow
        label={`${count} model${count === 1 ? "" : "s"}`}
        description={
          result === undefined
            ? ""
            : result.ok
              ? `Answered in ${result.latencyMs} ms. ${result.added} added, ${result.removed} dropped.`
              : result.reason
        }
        control={
          <div className="flex items-center gap-2">
            <Button variant="outline" disabled={refresh.isPending} onClick={() => refresh.mutate()}>
              <RefreshCw className={refresh.isPending ? "animate-spin" : ""} />
              {refresh.isPending ? "Reading…" : "Refresh models"}
            </Button>
          </div>
        }
      />
    </SettingsSection>
  );
}

function DangerZone({
  provider,
  onDeleted,
}: {
  provider: ModelProvider;
  onDeleted: () => Promise<void>;
}) {
  const [confirm, setConfirm] = useState(false);
  const remove = useMutation({
    mutationFn: () => rpcClient.modelProviders.providers.delete({ name: provider.name }),
    onSuccess: async () => {
      toast.success(`${provider.label} removed`);
      await onDeleted();
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  return (
    <SettingsSection
      title="Danger zone"
      description="Removing a provider takes its stored credential with it."
    >
      <SettingRow
        label={`Remove ${provider.label}`}
        control={
          <Button variant="destructive" onClick={() => setConfirm(true)}>
            <Trash2 />
            Remove
          </Button>
        }
      />
      <AlertDialog open={confirm} onOpenChange={setConfirm}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {provider.label}?</AlertDialogTitle>
            <AlertDialogDescription>
              Any role whose first entry names it falls through to the next one, and a role left
              with nothing degrades: turns cannot run, embeddings fall back to lexical search.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant="destructive"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Removing…" : "Remove provider"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}
