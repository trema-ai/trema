import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { CopyButton } from "#web/components/trema/copy-button.tsx";
import { RelativeTime } from "#web/components/trema/relative-time.tsx";
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
  DialogHeader,
  DialogTitle,
} from "#web/components/ui/dialog.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { orpc, rpcClient } from "#web/lib/api.ts";
import {
  type CatalogProvider,
  messageFrom,
  type Registration,
} from "#web/pages/settings/connectors/shared.tsx";

type RegistrationValues = { clientId: string; clientSecret: string; signingSecret?: string };

export function RegistrationDialog({
  provider,
  registrations,
  callbackUrl,
  open,
  onOpenChange,
  onSaved,
}: {
  provider: CatalogProvider;
  registrations: Registration[];
  callbackUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSaved?: () => void;
}) {
  const queryClient = useQueryClient();
  const customerApp = registrations.find((registration) => registration.source === "customer");
  const platformApp = registrations.find(
    (registration) => registration.source === "platform" && registration.isUsable,
  );
  const [editing, setEditing] = useState(false);
  const [pendingReplacement, setPendingReplacement] = useState<RegistrationValues>();
  const [confirmRemove, setConfirmRemove] = useState(false);
  const registrationKey = orpc.connectors.registrations.list.queryOptions({}).queryKey;
  const registrationMutationQueryKeys = [
    registrationKey,
    orpc.connectors.connections.list.key(),
    orpc.connectors.installations.list.key(),
    ...(provider.key === "slack" ? [orpc.messaging.slack.installations.list.key()] : []),
  ];
  const needsConfiguration =
    provider.key === "slack" && customerApp !== undefined && !customerApp.isUsable;
  const showForm = editing || !customerApp || needsConfiguration;

  const save = useMutation({
    mutationFn: (values: RegistrationValues) =>
      rpcClient.connectors.registrations.create({
        providerKey: provider.key,
        source: "customer",
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        ...(values.signingSecret ? { signingSecret: values.signingSecret } : {}),
        replace: true,
      }),
    onSuccess: async () => {
      await Promise.all(
        registrationMutationQueryKeys.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
      setEditing(false);
      setPendingReplacement(undefined);
      toast.success(`${provider.displayName} app saved`);
      onSaved?.();
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => rpcClient.connectors.registrations.delete({ id }),
    onSuccess: async () => {
      await Promise.all(
        registrationMutationQueryKeys.map((queryKey) =>
          queryClient.invalidateQueries({ queryKey }),
        ),
      );
      setConfirmRemove(false);
      toast.success("OAuth app removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const values = {
      clientId: String(data.get("clientId")),
      clientSecret: String(data.get("clientSecret")),
      ...(provider.key === "slack" ? { signingSecret: String(data.get("signingSecret")) } : {}),
    };
    if (customerApp) {
      setPendingReplacement(values);
      return;
    }
    save.mutate(values);
  }

  const truncatedClientId = customerApp?.clientId
    ? customerApp.clientId.length <= 12
      ? customerApp.clientId
      : `${customerApp.clientId.slice(0, 6)}…${customerApp.clientId.slice(-4)}`
    : null;

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        onOpenChange(next);
        if (!next) {
          setEditing(false);
          setPendingReplacement(undefined);
        }
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{provider.displayName} OAuth app</DialogTitle>
          <DialogDescription>
            Your organization's app at {provider.displayName}. Tokens for this connector are minted
            through it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-5">
          <div className="space-y-2">
            <Label>Callback URL</Label>
            <div className="flex items-center rounded-sm border bg-muted/30 px-3 py-0.5">
              <code className="min-w-0 flex-1 truncate text-sm">{callbackUrl}</code>
              <CopyButton value={callbackUrl} />
            </div>
            <p className="text-meta text-muted-foreground">
              Register this callback URL when creating the app. The{" "}
              <a
                href={provider.docsUrl}
                target="_blank"
                rel="noreferrer"
                className="text-moss hover:underline"
              >
                provider guide
              </a>{" "}
              shows where.
            </p>
          </div>
          {customerApp && !editing && !needsConfiguration ? (
            <div className="flex items-center justify-between gap-4 rounded-md border p-3">
              <div className="min-w-0 text-chrome">
                <p className="font-mono text-meta">{truncatedClientId}</p>
                <p className="mt-1 text-meta text-muted-foreground">
                  Added <RelativeTime date={customerApp.createdAt} />
                </p>
              </div>
              <div className="flex gap-2">
                <Button size="sm" variant="outline" onClick={() => setEditing(true)}>
                  Replace
                </Button>
                <Button size="sm" variant="destructive" onClick={() => setConfirmRemove(true)}>
                  <Trash2 />
                  Remove
                </Button>
              </div>
            </div>
          ) : null}
          {showForm ? (
            <form onSubmit={submit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor={`client-id-${provider.key}`}>Client ID</Label>
                <Input id={`client-id-${provider.key}`} name="clientId" required />
              </div>
              {provider.key === "slack" ? (
                <div className="space-y-2">
                  <Label htmlFor="signing-secret-slack">Signing secret</Label>
                  <Input
                    id="signing-secret-slack"
                    name="signingSecret"
                    type="password"
                    required
                    autoComplete="new-password"
                  />
                  <p className="text-meta text-muted-foreground">
                    Copy this value from your Slack app's Basic Information page. Trema stores it
                    encrypted and write-only.
                  </p>
                </div>
              ) : null}
              <div className="space-y-2">
                <Label htmlFor={`client-secret-${provider.key}`}>Client secret</Label>
                <Input
                  id={`client-secret-${provider.key}`}
                  name="clientSecret"
                  type="password"
                  required
                  autoComplete="new-password"
                />
                <p className="text-meta text-muted-foreground">
                  Stored encrypted and write-only; it cannot be viewed later.
                </p>
              </div>
              <div className="flex justify-end gap-2">
                {editing ? (
                  <Button type="button" variant="outline" onClick={() => setEditing(false)}>
                    Cancel
                  </Button>
                ) : null}
                <Button disabled={save.isPending}>
                  {save.isPending ? "Saving…" : customerApp ? "Replace app" : "Save app"}
                </Button>
              </div>
            </form>
          ) : null}
          {platformApp && !customerApp ? (
            <p className="text-meta text-muted-foreground">
              A platform app is available, so connecting works without your own app. Adding your
              organization's app overrides it.
            </p>
          ) : null}
        </div>
        <AlertDialog
          open={pendingReplacement !== undefined}
          onOpenChange={(next) => {
            if (!next) setPendingReplacement(undefined);
          }}
        >
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Replace this OAuth app?</AlertDialogTitle>
              <AlertDialogDescription>
                Every connector account using this app will be revoked and stop working. To use
                those accounts again, you will need to reconnect them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={save.isPending}
                onClick={() => pendingReplacement && save.mutate(pendingReplacement)}
              >
                {save.isPending ? "Replacing…" : "Replace app and revoke accounts"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
        <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this OAuth app?</AlertDialogTitle>
              <AlertDialogDescription>
                Every connector account using this app will be revoked and stop working. To use
                those accounts again, you will need to reconnect them.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <AlertDialogAction
                variant="destructive"
                disabled={remove.isPending}
                onClick={() => customerApp && remove.mutate(customerApp.id)}
              >
                {remove.isPending ? "Removing…" : "Remove app"}
              </AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </DialogContent>
    </Dialog>
  );
}
