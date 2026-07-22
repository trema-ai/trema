import { useMutation, useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { KeyValueList } from "#/components/trema/key-value-list.tsx";
import { PageHeader } from "#/components/trema/page-header.tsx";
import { SettingRow, SettingsSection } from "#/components/trema/settings-section.tsx";
import { Alert, AlertDescription } from "#/components/ui/alert.tsx";
import { Button } from "#/components/ui/button.tsx";
import { Input } from "#/components/ui/input.tsx";
import { orpc, rpcClient } from "#/lib/api.ts";
import { useAuthenticatedSession, useViewerRole } from "#/pages/home.tsx";

export function SettingsGeneralPage() {
  const session = useAuthenticatedSession();
  const role = useViewerRole();
  const queryClient = useQueryClient();
  const [name, setName] = useState(session.membership.org.name);
  const [error, setError] = useState<string>();
  const mutation = useMutation({
    mutationFn: (nextName: string) => rpcClient.org.update({ name: nextName }),
    onSuccess: async () => {
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: orpc.org.list.queryOptions({}).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: orpc.scopes.list.queryOptions({ input: {} }).queryKey,
        }),
      ]);
      toast.success("Organization renamed");
    },
  });

  useEffect(() => setName(session.membership.org.name), [session.membership.org.name]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setError(undefined);
    try {
      await mutation.mutateAsync(name.trim());
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not rename organization");
    }
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <PageHeader
        title="General"
        description={
          role === "owner" ? "Manage organization details." : "View organization details."
        }
      />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection title="Organization">
        {role === "owner" ? (
          <>
            <SettingRow
              label="Name"
              description="The name shown for this organization."
              orientation="stack"
              control={
                <form className="flex max-w-md gap-2" onSubmit={save}>
                  <Input
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                    aria-label="Organization name"
                    required
                  />
                  <Button
                    disabled={mutation.isPending || name.trim() === session.membership.org.name}
                  >
                    {mutation.isPending ? "Saving…" : "Save"}
                  </Button>
                </form>
              }
            />
            <SettingRow
              label="ID"
              control={
                <span className="font-mono text-chrome text-muted-foreground">
                  {session.membership.org.id}
                </span>
              }
            />
          </>
        ) : (
          <KeyValueList
            className="p-4"
            items={[
              { label: "Name", value: session.membership.org.name },
              { label: "ID", value: session.membership.org.id, mono: true },
            ]}
          />
        )}
      </SettingsSection>
    </main>
  );
}
