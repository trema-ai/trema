import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Navigate, useNavigate, useSearchParams } from "react-router";
import { AuthLayout } from "#web/components/trema/auth-layout.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { authClient, orpc, rpcClient } from "#web/lib/api.ts";
import { Loading } from "#web/pages/home.tsx";

export function JoinPage() {
  const session = authClient.useSession();
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const token = search.get("token");
  const preview = useQuery(
    orpc.members.invites.preview.queryOptions({
      input: { token: token ?? "" },
      enabled: Boolean(token) && Boolean(session.data),
      retry: false,
    }),
  );
  if (!token)
    return (
      <AuthLayout title="Join organization">
        <Alert variant="destructive">
          <AlertDescription>This invite link is missing its token.</AlertDescription>
        </Alert>
      </AuthLayout>
    );
  if (!session.data) {
    const returnTo = `/join?token=${encodeURIComponent(token)}`;
    return <Navigate to={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }
  if (preview.isPending) return <Loading />;
  if (preview.error)
    return (
      <AuthLayout title="Join organization">
        <Alert variant="destructive">
          <AlertDescription>
            This invite is invalid, expired, or has already been redeemed.
          </AlertDescription>
        </Alert>
      </AuthLayout>
    );
  const { orgName, invitedBy } = preview.data;
  async function redeem() {
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      const joined = await rpcClient.members.invites.redeem({ token });
      await rpcClient.org.switch({ orgId: joined.orgId });
      await session.refetch();
      navigate("/", { replace: true });
      queryClient.invalidateQueries();
    } catch (cause) {
      const message = cause instanceof Error ? cause.message : "Invite redemption failed";
      setError(
        /member/i.test(message)
          ? "You are already a member of this organization."
          : "This invite is invalid, expired, or has already been redeemed.",
      );
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title={`Join ${orgName}`}
      description={`${invitedBy} invited you to join ${orgName} on Trema.`}
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button className="w-full" disabled={busy} onClick={redeem}>
          {busy ? "Joining…" : `Join ${orgName}`}
        </Button>
      </div>
    </AuthLayout>
  );
}
