import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useEffect, useState } from "react";
import { toast } from "sonner";

import { PageHeader } from "#web/components/trema/page-header.tsx";
import { SettingRow, SettingsSection } from "#web/components/trema/settings-section.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { authClient, orpc } from "#web/lib/api.ts";
import { useAuthenticatedSession } from "#web/pages/home.tsx";

export function SettingsProfilePage() {
  const session = useAuthenticatedSession();
  const queryClient = useQueryClient();
  const [displayName, setDisplayName] = useState(session.user.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => setDisplayName(session.user.name), [session.user.name]);

  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const name = displayName.trim();
    if (!name) return;
    setSaving(true);
    setError(undefined);
    const result = await authClient.updateUser({ name });
    if (result.error) {
      setError(result.error.message ?? "Could not update profile");
    } else {
      await Promise.all([
        session.refreshSession(),
        queryClient.invalidateQueries({
          queryKey: orpc.org.list.queryOptions({}).queryKey,
        }),
        queryClient.invalidateQueries({
          queryKey: orpc.members.list.queryOptions({}).queryKey,
        }),
      ]);
      toast.success("Profile updated");
    }
    setSaving(false);
  }

  return (
    <main className="mx-auto w-full max-w-3xl p-4 sm:p-6 lg:p-8">
      <PageHeader title="Profile" description="Manage your account details." />
      {error ? (
        <Alert variant="destructive" className="mb-5">
          <AlertDescription>{error}</AlertDescription>
        </Alert>
      ) : null}
      <SettingsSection title="Account">
        <SettingRow
          label="Display name"
          description="The name shown for your Trema account."
          orientation="stack"
          control={
            <form className="flex max-w-md gap-2" onSubmit={save}>
              <Input
                value={displayName}
                onChange={(event) => setDisplayName(event.target.value)}
                aria-label="Display name"
                required
              />
              <Button disabled={saving || displayName.trim() === session.user.name}>
                {saving ? "Saving…" : "Save"}
              </Button>
            </form>
          }
        />
        <SettingRow
          label="Email"
          description="The email used to sign in."
          control={<span className="text-chrome text-muted-foreground">{session.user.email}</span>}
        />
      </SettingsSection>
    </main>
  );
}
