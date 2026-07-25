import { useQueryClient } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Navigate, useNavigate } from "react-router";
import { AuthLayout } from "#web/components/trema/auth-layout.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { Textarea } from "#web/components/ui/textarea.tsx";
import { authClient, rpcClient } from "#web/lib/api.ts";
import { SignInPage } from "#web/pages/sign-in.tsx";

export function BootstrapPage({
  needsBootstrap,
  providers,
  legal,
}: {
  needsBootstrap: boolean;
  providers: { password: boolean; google: boolean };
  legal: { termsUrl: string | null; privacyUrl: string | null };
}) {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (!needsBootstrap) return <Navigate to="/" replace />;
  if (!session.data) return <SignInPage providers={providers} legal={legal} defaultCreating />;
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    const data = new FormData(event.currentTarget);
    try {
      await rpcClient.bootstrap.redeem({
        token: String(data.get("token")).trim(),
        orgName: String(data.get("orgName")),
      });
      await Promise.all([session.refetch(), queryClient.invalidateQueries()]);
      navigate("/", { replace: true });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Bootstrap failed");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title="Set up Trema"
      description={
        <>
          Use the token supplied as <code className="font-mono">TREMA_BOOTSTRAP_TOKEN</code>, or
          printed once in the server log at first start.
        </>
      }
    >
      <form className="space-y-4" onSubmit={submit}>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="org-name">Organization name</Label>
          <Input id="org-name" name="orgName" required />
        </div>
        <div className="space-y-2">
          <Label htmlFor="bootstrap-token">Bootstrap token</Label>
          <Textarea
            className="min-h-16 break-all font-mono"
            id="bootstrap-token"
            name="token"
            autoComplete="off"
            spellCheck={false}
            required
          />
        </div>
        <Button className="w-full" disabled={busy}>
          {busy ? "Setting up…" : "Set up Trema"}
        </Button>
      </form>
    </AuthLayout>
  );
}
