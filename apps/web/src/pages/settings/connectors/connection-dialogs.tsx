import { useMutation } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";
import { Button } from "#web/components/ui/button.tsx";
import { Checkbox } from "#web/components/ui/checkbox.tsx";
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
import { rpcClient } from "#web/lib/api.ts";
import { scopeDisplayName } from "#web/lib/scopes.ts";
import {
  type CatalogProvider,
  type ConnectorConnection,
  type FieldDescriptor,
  messageFrom,
  type Scope,
} from "#web/pages/settings/connectors/shared.tsx";

function returnUrl() {
  const url = new URL(window.location.href);
  url.searchParams.delete("connected");
  url.searchParams.delete("connector_error");
  url.searchParams.delete("connector_status");
  return url.toString();
}

function fieldInput(
  providerKey: string,
  name: string,
  descriptor: FieldDescriptor,
  kind: "config" | "credential",
) {
  if (descriptor.automated) return null;
  const id = `${kind}-${providerKey}-${name}`;
  return (
    <div key={name} className="space-y-2">
      <Label htmlFor={id}>{descriptor.title}</Label>
      <div className="flex items-center gap-2">
        {descriptor.prefix ? (
          <span className="text-meta text-muted-foreground">{descriptor.prefix}</span>
        ) : null}
        <Input
          id={id}
          name={`${kind}:${name}`}
          type={descriptor.secret ? "password" : "text"}
          placeholder={descriptor.example}
          defaultValue={descriptor.default}
          required={!descriptor.optional}
          pattern={descriptor.pattern}
          autoComplete={descriptor.secret ? "new-password" : undefined}
        />
        {descriptor.suffix ? (
          <span className="text-meta text-muted-foreground">{descriptor.suffix}</span>
        ) : null}
      </div>
      {descriptor.description ? (
        <p className="text-meta text-muted-foreground">{descriptor.description}</p>
      ) : null}
    </div>
  );
}

function submittedFields(data: FormData, prefix: "config" | "credential"): Record<string, string> {
  return Object.fromEntries(
    [...data.entries()].flatMap(([name, value]) => {
      const fieldPrefix = `${prefix}:`;
      if (!name.startsWith(fieldPrefix) || typeof value !== "string" || value === "") return [];
      return [[name.slice(fieldPrefix.length), value]];
    }),
  );
}

export function StaticConnectionDialog({
  provider,
  reconnect,
  open,
  onOpenChange,
  onConnected,
}: {
  provider: CatalogProvider;
  reconnect?: ConnectorConnection | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onConnected: (connectionId: string) => void | Promise<void>;
}) {
  const create = useMutation({
    mutationFn: (values: {
      config: Record<string, string>;
      credentials: Record<string, string>;
    }) => {
      const input = {
        providerKey: provider.key,
        config: values.config,
        credentials: values.credentials,
        ...(reconnect ? { reconnectConnectionId: reconnect.id } : {}),
      };
      return rpcClient.connectors.connect.createStatic(input);
    },
    onSuccess: async ({ id }) => {
      toast.success(`${provider.displayName} ${reconnect ? "reconnected" : "connected"}`);
      onOpenChange(false);
      await onConnected(id);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    create.mutate({
      config: submittedFields(data, "config"),
      credentials: submittedFields(data, "credential"),
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {reconnect ? "Reconnect" : "Connect"} {provider.displayName}
            </DialogTitle>
            <DialogDescription>
              The credential is verified, encrypted, and never shown again.
            </DialogDescription>
          </DialogHeader>
          <div className="my-5 space-y-4">
            {Object.entries(provider.configFields).map(([name, descriptor]) =>
              fieldInput(provider.key, name, descriptor, "config"),
            )}
            {Object.entries(provider.credentialFields).map(([name, descriptor]) =>
              fieldInput(provider.key, name, descriptor, "credential"),
            )}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={create.isPending}>
              {create.isPending ? "Verifying…" : "Connect"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

export function OAuthConnectionDialog({
  provider,
  reconnect,
  audience = "admin",
  scopes = [],
  defaultScopeId,
  open,
  onOpenChange,
}: {
  provider: CatalogProvider;
  reconnect?: ConnectorConnection | undefined;
  audience?: "admin" | "member";
  scopes?: Scope[];
  defaultScopeId?: string | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const defaultScopes = reconnect?.providerScopes.length
    ? reconnect.providerScopes
    : provider.defaultScopes;
  const [selectedScopes, setSelectedScopes] = useState<string[]>(defaultScopes);
  const [targetScopeId, setTargetScopeId] = useState(
    defaultScopeId ?? scopes.find((scope) => scope.kind === "org")?.id ?? scopes[0]?.id ?? "",
  );
  useEffect(() => {
    if (!open) return;
    setSelectedScopes(defaultScopes);
    setTargetScopeId(
      defaultScopeId ?? scopes.find((scope) => scope.kind === "org")?.id ?? scopes[0]?.id ?? "",
    );
  }, [open, defaultScopes, defaultScopeId, scopes]);
  const start = useMutation({
    mutationFn: (config: Record<string, string>) => {
      const sharedInput = {
        providerKey: provider.key,
        ...(Object.keys(config).length > 0 ? { config } : {}),
        ...(provider.availableScopes ? { providerScopes: selectedScopes } : {}),
        ...(reconnect ? { reconnectConnectionId: reconnect.id } : {}),
        returnTo: returnUrl(),
      };
      return audience === "member"
        ? rpcClient.connectors.member.connect.startOAuth(sharedInput)
        : rpcClient.connectors.connect.startOAuth({
            ...sharedInput,
            scopeId: targetScopeId,
          });
    },
    onSuccess: ({ authorizationUrl }) => window.location.assign(authorizationUrl),
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    start.mutate(submittedFields(new FormData(event.currentTarget), "config"));
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <form onSubmit={submit}>
          <DialogHeader>
            <DialogTitle>
              {reconnect ? "Reconnect" : "Connect"} {provider.displayName}
            </DialogTitle>
            <DialogDescription>
              {audience === "member"
                ? "Authorize the provider account to connect to your personal scope."
                : "Authorize an organization-controlled account for shared use."}
            </DialogDescription>
          </DialogHeader>
          <div className="my-5 space-y-4">
            {audience === "admin" ? (
              <div className="space-y-2">
                <Label htmlFor={`oauth-target-${provider.key}`}>Available in</Label>
                <Select value={targetScopeId} onValueChange={setTargetScopeId}>
                  <SelectTrigger id={`oauth-target-${provider.key}`} className="w-full">
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
                <p className="text-meta text-muted-foreground">
                  The callback installs this connection in the selected scope.
                </p>
              </div>
            ) : null}
            {Object.entries(provider.configFields).map(([name, descriptor]) =>
              fieldInput(provider.key, name, descriptor, "config"),
            )}
            {provider.availableScopes ? (
              <div className="space-y-3">
                <div>
                  <Label>Provider scopes</Label>
                  <p className="text-meta text-muted-foreground">
                    Choose what the provider token may access.
                  </p>
                </div>
                <div className="max-h-56 space-y-2 overflow-y-auto rounded-md border p-3">
                  {provider.availableScopes.map((scope) => (
                    <label
                      key={scope}
                      htmlFor={`oauth-scope-${provider.key}-${scope}`}
                      className="flex items-center gap-2 text-chrome"
                    >
                      <Checkbox
                        id={`oauth-scope-${provider.key}-${scope}`}
                        checked={selectedScopes.includes(scope)}
                        onCheckedChange={(checked) =>
                          setSelectedScopes((current) =>
                            checked
                              ? [...current, scope]
                              : current.filter((candidate) => candidate !== scope),
                          )
                        }
                      />
                      <span className="font-mono text-meta">{scope}</span>
                    </label>
                  ))}
                </div>
              </div>
            ) : null}
          </div>
          <DialogFooter>
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
            <Button disabled={start.isPending || (audience === "admin" && !targetScopeId)}>
              {start.isPending ? "Redirecting…" : reconnect ? "Reconnect" : "Continue"}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
