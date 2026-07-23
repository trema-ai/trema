import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Trash2 } from "lucide-react";
import { type FormEvent, useState } from "react";
import { toast } from "sonner";

import { CopyButton } from "#/components/trema/copy-button.tsx";
import { RelativeTime } from "#/components/trema/relative-time.tsx";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "#/components/ui/alert-dialog.tsx";
import { Button } from "#/components/ui/button.tsx";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "#/components/ui/dialog.tsx";
import { Input } from "#/components/ui/input.tsx";
import { Label } from "#/components/ui/label.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import {
  type CatalogProvider,
  messageFrom,
  type Registration,
} from "#/pages/settings/connectors-shared.tsx";

export function RegistrationDialog({
  provider,
  registrations,
  callbackUrl,
  open,
  onOpenChange,
}: {
  provider: CatalogProvider;
  registrations: Registration[];
  callbackUrl: string;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const queryClient = useQueryClient();
  const customerApp = registrations.find((registration) => registration.source === "customer");
  const platformApp = registrations.find(
    (registration) => registration.source === "platform" && registration.isUsable,
  );
  const [editing, setEditing] = useState(false);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const registrationKey = orpc.connectors.registrations.list.queryOptions({}).queryKey;
  const showForm = editing || !customerApp;

  const save = useMutation({
    mutationFn: (values: { clientId: string; clientSecret: string }) =>
      rpcClient.connectors.registrations.create({
        providerKey: provider.key,
        source: "customer",
        clientId: values.clientId,
        clientSecret: values.clientSecret,
        replace: true,
      }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: registrationKey });
      setEditing(false);
      toast.success(`${provider.displayName} app saved`);
    },
    onError: (error) => toast.error(messageFrom(error)),
  });
  const remove = useMutation({
    mutationFn: (id: string) => rpcClient.connectors.registrations.delete({ id }),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey: registrationKey });
      setConfirmRemove(false);
      toast.success("OAuth app removed");
    },
    onError: (error) => toast.error(messageFrom(error)),
  });

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    save.mutate({
      clientId: String(data.get("clientId")),
      clientSecret: String(data.get("clientSecret")),
    });
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
        if (!next) setEditing(false);
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
            <div className="flex items-center rounded-md border bg-muted/30 px-3">
              <code className="min-w-0 flex-1 truncate text-meta">{callbackUrl}</code>
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
          {customerApp && !editing ? (
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
                  {save.isPending ? "Saving…" : editing ? "Replace app" : "Save app"}
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
        <AlertDialog open={confirmRemove} onOpenChange={setConfirmRemove}>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this OAuth app?</AlertDialogTitle>
              <AlertDialogDescription>
                New connections can no longer use it. Existing credentials are unchanged.
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
