import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";
import { Link, Navigate, useSearchParams } from "react-router";
import { AuthLayout } from "#web/components/trema/auth-layout.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { authClient, orpc, rpcClient } from "#web/lib/api.ts";
import { Loading } from "#web/pages/home.tsx";

type IdentityLinkConflictReason = "identity_conflict" | "deactivated" | "not_a_member";

function identityLinkConflictReason(cause: unknown): IdentityLinkConflictReason | undefined {
  if (
    typeof cause !== "object" ||
    cause === null ||
    !("data" in cause) ||
    typeof cause.data !== "object" ||
    cause.data === null ||
    !("reason" in cause.data)
  ) {
    return undefined;
  }
  const reason = cause.data.reason;
  if (reason === "identity_conflict" || reason === "deactivated" || reason === "not_a_member") {
    return reason;
  }
  return undefined;
}

function redeemFailureMessage(cause: unknown): string {
  switch (identityLinkConflictReason(cause)) {
    case "identity_conflict":
      return "This Slack account is already linked to another Trema member. Ask a Trema administrator to resolve the conflict.";
    case "deactivated":
      return "A deactivated member cannot link a Slack identity.";
    case "not_a_member":
      return "You must be an active member of this organization to link this Slack account.";
    default:
      return "This link is invalid, expired, or has already been used.";
  }
}

export function LinkSlackPage() {
  const session = authClient.useSession();
  const [search] = useSearchParams();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [linked, setLinked] = useState<{ workspaceId: string; userId: string }>();
  const token = search.get("token");
  const preview = useQuery(
    orpc.messaging.slack.identityChallenges.preview.queryOptions({
      input: { token: token ?? "" },
      enabled: Boolean(token) && linked === undefined,
      retry: false,
    }),
  );

  if (!token) {
    return (
      <AuthLayout title="Link Slack account">
        <Alert variant="destructive">
          <AlertDescription>This link is missing its challenge token.</AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }

  if (!session.data) {
    const returnTo = `/link/slack?token=${encodeURIComponent(token)}`;
    return <Navigate to={`/sign-in?returnTo=${encodeURIComponent(returnTo)}`} replace />;
  }

  if (linked) {
    return (
      <AuthLayout
        title="Slack account linked"
        description={`Slack user ${linked.userId} in workspace ${linked.workspaceId} is linked to your Trema account. Return to Slack and retry your original message.`}
      >
        <Button asChild className="w-full">
          <Link to="/runs">Continue in Trema</Link>
        </Button>
      </AuthLayout>
    );
  }

  if (preview.isPending) return <Loading />;

  if (preview.error) {
    return (
      <AuthLayout title="Link Slack account">
        <Alert variant="destructive">
          <AlertDescription>
            This link is invalid, expired, or has already been used.
          </AlertDescription>
        </Alert>
      </AuthLayout>
    );
  }

  const { orgName, workspaceId, userId } = preview.data;

  async function redeem() {
    if (!token) return;
    setBusy(true);
    setError(undefined);
    try {
      const result = await rpcClient.messaging.slack.identityChallenges.redeem({ token });
      await rpcClient.org.switch({ orgId: result.orgId });
      await session.refetch();
      queryClient.invalidateQueries();
      setLinked({ workspaceId: result.workspaceId, userId: result.userId });
    } catch (cause) {
      setError(redeemFailureMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <AuthLayout
      title={`Link Slack to ${orgName}`}
      description={`Connect Slack user ${userId} in workspace ${workspaceId} to your Trema account, then retry your Slack message.`}
    >
      <div className="space-y-4">
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button className="w-full" disabled={busy} onClick={redeem}>
          {busy ? "Linking…" : "Link my Trema account"}
        </Button>
      </div>
    </AuthLayout>
  );
}
