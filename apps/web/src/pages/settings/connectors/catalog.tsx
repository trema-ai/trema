import { useMutation, useQuery } from "@tanstack/react-query";
import { ArrowLeft, Plus, Settings2 } from "lucide-react";
import { useState } from "react";
import { useNavigate } from "react-router";
import { toast } from "sonner";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Card,
  CardAction,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "#/components/ui/card.tsx";
import { Checkbox } from "#/components/ui/checkbox.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Label } from "#/components/ui/label.tsx";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "#/components/ui/select.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { scopeDisplayName } from "#/lib/scopes.ts";
import { RegistrationDialog } from "#/pages/settings/connectors/registration-dialog.tsx";
import {
  type CatalogProvider,
  categoryLabel,
  messageFrom,
  providerLogo,
  type Registration,
  type Scope,
} from "#/pages/settings/connectors/shared.tsx";

function hasUsableRegistration(provider: CatalogProvider, registrations: Registration[]) {
  // mcp_oauth providers register their client dynamically (RFC 7591) during the
  // first connect, so they never require a pre-configured OAuth app.
  if (provider.authMode !== "oauth2_code") return true;
  return registrations.some(
    (registration) => registration.providerKey === provider.key && registration.isUsable,
  );
}

export function SettingsConnectorCatalogPage() {
  const navigate = useNavigate();
  const catalog = useQuery(orpc.connectors.catalog.list.queryOptions({}));
  const registrations = useQuery(orpc.connectors.registrations.list.queryOptions({}));
  const scopes = useQuery(orpc.scopes.list.queryOptions({ input: {} }));
  const meta = useQuery(orpc.connectors.meta.queryOptions({}));
  const providers = (catalog.data ?? []) as CatalogProvider[];
  const registrationRows = (registrations.data ?? []) as Registration[];
  const scopeRows = ((scopes.data ?? []) as Scope[]).filter(
    (scope) => scope.kind === "org" || scope.kind === "shared",
  );
  const error = catalog.error ?? registrations.error ?? scopes.error ?? meta.error;

  return (
    <main className="mx-auto w-full max-w-5xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="Connector catalog"
        description="Install a provider or configure the OAuth app used to connect it."
        actions={
          <Button variant="outline" onClick={() => navigate("/settings/connectors")}>
            <ArrowLeft />
            Installed connectors
          </Button>
        }
      />
      {error ? <p className="mb-4 text-sm text-destructive">{error.message}</p> : null}
      {catalog.isPending || registrations.isPending || scopes.isPending || meta.isPending ? (
        <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {[1, 2, 3].map((key) => (
            <div key={key} className="h-40 animate-pulse rounded-xl border bg-muted/40" />
          ))}
        </div>
      ) : (
        <div className="space-y-8">
          <CatalogSection
            title="Ready to install"
            description="Connect these without further configuration."
            providers={providers.filter((provider) =>
              hasUsableRegistration(provider, registrationRows),
            )}
            registrations={registrationRows}
            scopes={scopeRows}
            callbackUrl={meta.data?.callbackUrl ?? ""}
          />
          <CatalogSection
            title="Needs setup"
            description="Add the organization's OAuth app before installing."
            providers={providers.filter(
              (provider) => !hasUsableRegistration(provider, registrationRows),
            )}
            registrations={registrationRows}
            scopes={scopeRows}
            callbackUrl={meta.data?.callbackUrl ?? ""}
          />
        </div>
      )}
    </main>
  );
}

function CatalogSection({
  title,
  description,
  providers,
  registrations,
  scopes,
  callbackUrl,
}: {
  title: string;
  description: string;
  providers: CatalogProvider[];
  registrations: Registration[];
  scopes: Scope[];
  callbackUrl: string;
}) {
  if (providers.length === 0) return null;
  return (
    <section>
      <h2 className="font-medium">{title}</h2>
      <p className="mt-0.5 text-meta text-muted-foreground">{description}</p>
      <div className="mt-3 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {providers.map((provider) => (
          <ProviderCard
            key={provider.key}
            provider={provider}
            registrations={registrations}
            scopes={scopes}
            callbackUrl={callbackUrl}
          />
        ))}
      </div>
    </section>
  );
}

function ProviderCard({
  provider,
  registrations,
  scopes,
  callbackUrl,
}: {
  provider: CatalogProvider;
  registrations: Registration[];
  scopes: Scope[];
  callbackUrl: string;
}) {
  const [installOpen, setInstallOpen] = useState(false);
  const [registrationOpen, setRegistrationOpen] = useState(false);
  const ready = hasUsableRegistration(provider, registrations);

  return (
    <Card className="gap-2 py-4 shadow-xs">
      <CardHeader className="px-4">
        <div className="flex items-center gap-2">
          {providerLogo(provider)}
          <div className="min-w-0">
            <CardTitle>{provider.displayName}</CardTitle>
            <p className="mt-0.5 text-meta text-muted-foreground">
              {categoryLabel(provider.categories)}
            </p>
          </div>
        </div>
        <CardAction>
          {ready ? (
            <Button size="xs" onClick={() => setInstallOpen(true)}>
              <Plus />
              Install
            </Button>
          ) : (
            <Button size="xs" variant="outline" onClick={() => setRegistrationOpen(true)}>
              <Settings2 />
              Setup
            </Button>
          )}
        </CardAction>
      </CardHeader>
      <CardContent className="px-4">
        <CardDescription>{provider.description ?? "No description available."}</CardDescription>
      </CardContent>
      <InstallDialog
        provider={provider}
        scopes={scopes}
        open={installOpen}
        onOpenChange={setInstallOpen}
      />
      <RegistrationDialog
        provider={provider}
        registrations={registrations.filter(
          (registration) => registration.providerKey === provider.key,
        )}
        callbackUrl={callbackUrl}
        open={registrationOpen}
        onOpenChange={setRegistrationOpen}
      />
    </Card>
  );
}

function InstallDialog({
  provider,
  scopes,
  open,
  onOpenChange,
}: {
  provider: CatalogProvider;
  scopes: Scope[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const navigate = useNavigate();
  const [scopeId, setScopeId] = useState("");
  const [allTools, setAllTools] = useState(true);
  const [selectedTools, setSelectedTools] = useState<string[]>([]);
  const availableScopes = provider.availableScopes ?? [];
  const showScopePicker = provider.authMode === "oauth2_code" && availableScopes.length > 0;
  const [selectedScopes, setSelectedScopes] = useState<string[]>(provider.defaultScopes ?? []);
  const defaultScopeSet = new Set(provider.defaultScopes ?? []);
  const scopesDifferFromDefault =
    selectedScopes.length !== defaultScopeSet.size ||
    selectedScopes.some((scope) => !defaultScopeSet.has(scope));
  const mutation = useMutation({
    mutationFn: () =>
      rpcClient.connectors.installations.create({
        scopeId,
        catalogKey: provider.key,
        enabledTools: allTools ? "all" : selectedTools,
        // Only override when the operator narrowed or widened the defaults.
        ...(showScopePicker && scopesDifferFromDefault ? { providerScopes: selectedScopes } : {}),
      }),
    onSuccess: (installation) => {
      toast.success(`${provider.displayName} installed`);
      onOpenChange(false);
      // Static-auth providers go straight to the credential dialog on the
      // detail screen; OAuth providers land on the normal connect flow.
      const isStatic = provider.authMode === "api_key" || provider.authMode === "basic";
      navigate(`/settings/connectors/${installation.id}${isStatic ? "?connect=1" : ""}`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const tools = provider.toolManifest ?? [];

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (next && !scopeId && scopes[0]) setScopeId(scopes[0].id);
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Install {provider.displayName}</DialogTitle>
          <DialogDescription>Choose the scope and tools this connector can use.</DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label htmlFor={`scope-${provider.key}`}>Scope</Label>
            <Select value={scopeId} onValueChange={setScopeId}>
              <SelectTrigger id={`scope-${provider.key}`} className="w-full">
                <SelectValue placeholder="Choose a scope" />
              </SelectTrigger>
              <SelectContent>
                {scopes.map((scope) => (
                  <SelectItem key={scope.id} value={scope.id}>
                    {scopeDisplayName(scope)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {scopes.find((scope) => scope.id === scopeId)?.kind === "org" ? (
              <p className="text-meta text-muted-foreground">
                An organization install makes this connector available in every session across the
                organization.{" "}
                <a
                  href="https://trema.so/docs/credential-security"
                  target="_blank"
                  rel="noreferrer"
                  className="text-moss hover:underline"
                >
                  Credential security
                </a>{" "}
                covers how its credentials are handled.
              </p>
            ) : null}
          </div>
          {provider.transport.type === "rest" && tools.length > 0 ? (
            <div className="space-y-3">
              <div className="flex items-center gap-2">
                <Checkbox
                  id={`all-tools-${provider.key}`}
                  checked={allTools}
                  onCheckedChange={(checked) => setAllTools(checked === true)}
                />
                <Label htmlFor={`all-tools-${provider.key}`}>Enable all tools</Label>
              </div>
              {!allTools ? (
                <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                  {tools.map((tool) => (
                    <label
                      key={tool.name}
                      htmlFor={`install-${provider.key}-${tool.name}`}
                      className="flex items-start gap-2 text-chrome"
                    >
                      <Checkbox
                        id={`install-${provider.key}-${tool.name}`}
                        checked={selectedTools.includes(tool.name)}
                        onCheckedChange={(checked) =>
                          setSelectedTools((current) =>
                            checked
                              ? [...current, tool.name]
                              : current.filter((name) => name !== tool.name),
                          )
                        }
                      />
                      <span>
                        <span className="block font-medium">{tool.name}</span>
                        <span className="text-meta text-muted-foreground">{tool.description}</span>
                      </span>
                    </label>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}
          {showScopePicker ? (
            <div className="space-y-3">
              <div>
                <Label>OAuth scopes</Label>
                <p className="text-meta text-muted-foreground">
                  Scopes requested when a member connects their account. Defaults are pre-selected.
                </p>
              </div>
              <div className="max-h-48 space-y-2 overflow-y-auto rounded-md border p-3">
                {availableScopes.map((scope) => (
                  <label
                    key={scope}
                    htmlFor={`scope-${provider.key}-${scope}`}
                    className="flex items-start gap-2 text-chrome"
                  >
                    <Checkbox
                      id={`scope-${provider.key}-${scope}`}
                      checked={selectedScopes.includes(scope)}
                      onCheckedChange={(checked) =>
                        setSelectedScopes((current) =>
                          checked ? [...current, scope] : current.filter((name) => name !== scope),
                        )
                      }
                    />
                    <span className="font-medium">{scope}</span>
                  </label>
                ))}
              </div>
            </div>
          ) : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!scopeId || mutation.isPending} onClick={() => mutation.mutate()}>
            {mutation.isPending ? "Installing…" : "Install connector"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
