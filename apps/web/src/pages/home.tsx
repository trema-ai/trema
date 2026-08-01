import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useContext,
  useEffect,
  useState,
} from "react";
import { Navigate, useNavigate } from "react-router";
import { AppShell } from "#web/components/trema/app-shell.tsx";
import { AuthLayout } from "#web/components/trema/auth-layout.tsx";
import { Alert, AlertDescription } from "#web/components/ui/alert.tsx";
import { Button } from "#web/components/ui/button.tsx";
import { Input } from "#web/components/ui/input.tsx";
import { Label } from "#web/components/ui/label.tsx";
import { authClient, orpc, rpcClient } from "#web/lib/api.ts";

type ViewerRole = "owner" | "admin" | "member" | "viewer";

type Organization = { id: string; name: string };
type Principal = { id: string; displayName: string; email: string | null };
type Membership = { org: Organization; principal: Principal };

type AuthenticatedSessionValue = {
  activeOrgId: string;
  membership: Membership;
  memberships: Membership[];
  role: ViewerRole;
  user: { name: string; email: string };
  refreshSession: () => Promise<void>;
  switchOrg: (orgId: string) => Promise<void>;
  signOut: () => Promise<void>;
};

const ViewerRoleContext = createContext<ViewerRole>("member");
const AuthenticatedSessionContext = createContext<AuthenticatedSessionValue | null>(null);

export function useViewerRole() {
  return useContext(ViewerRoleContext);
}

export function useAuthenticatedSession() {
  const context = useContext(AuthenticatedSessionContext);
  if (!context)
    throw new Error("useAuthenticatedSession must be used within AuthenticatedProvider");
  return context;
}

export function AuthenticatedProvider({
  mode,
  children,
}: {
  mode: "hosted" | "dedicated";
  children: ReactNode;
}) {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const memberships = useQuery(orpc.org.list.queryOptions({ enabled: Boolean(session.data) }));
  const [switching, setSwitching] = useState(false);
  const activeOrgId = session.data?.session.activeOrgId;
  const members = useQuery(orpc.members.list.queryOptions({ enabled: Boolean(activeOrgId) }));
  useEffect(() => {
    if (!activeOrgId && memberships.data?.[0] && !switching) {
      setSwitching(true);
      rpcClient.org
        .switch({ orgId: memberships.data[0].org.id })
        .then(() => session.refetch())
        .finally(() => setSwitching(false));
    }
  }, [activeOrgId, memberships.data, session, switching]);
  if (session.isPending) return <Loading />;
  if (!session.data) return <Navigate to="/sign-in" replace />;
  if (memberships.isPending || switching) return <Loading />;
  if (memberships.error) return <CenteredError error={memberships.error} />;
  if (!memberships.data?.length) return <NoOrganization mode={mode} />;
  if (!activeOrgId) return <Loading />;
  const membership = memberships.data.find((item) => item.org.id === activeOrgId);
  if (!membership) return <Loading />;
  if (members.isPending) return <Loading />;
  const role =
    members.data?.find((item) => item.principal.id === membership.principal.id)?.role ?? "member";
  async function switchOrg(orgId: string) {
    await rpcClient.org.switch({ orgId });
    await session.refetch();
    await queryClient.invalidateQueries();
  }
  async function signOut() {
    await authClient.signOut();
    queryClient.clear();
    navigate("/sign-in", { replace: true });
  }
  return (
    <AuthenticatedSessionContext.Provider
      value={{
        activeOrgId,
        membership,
        memberships: memberships.data,
        role,
        user: { name: session.data.user.name, email: session.data.user.email },
        refreshSession: async () => {
          await session.refetch();
        },
        switchOrg,
        signOut,
      }}
    >
      <ViewerRoleContext.Provider value={role}>{children}</ViewerRoleContext.Provider>
    </AuthenticatedSessionContext.Provider>
  );
}

export function AuthenticatedAppShell({ children }: { children: ReactNode }) {
  const session = useAuthenticatedSession();
  return (
    <AppShell
      orgName={session.membership.org.name}
      sidebar={{
        organizations: session.memberships.map(({ org }) => org),
        activeOrgId: session.activeOrgId,
        name: session.membership.principal.displayName,
        email: session.membership.principal.email ?? session.user.email,
        role: session.role,
        onSwitch: session.switchOrg,
        onSignOut: session.signOut,
      }}
    >
      {children}
    </AppShell>
  );
}

function NoOrganization({ mode }: { mode: "hosted" | "dedicated" }) {
  const session = authClient.useSession();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (mode === "dedicated")
    return (
      <AuthLayout title="No organization" description="Ask your administrator for an invite link.">
        <Button
          variant="outline"
          className="w-full"
          onClick={async () => {
            await authClient.signOut();
            navigate("/sign-in");
          }}
        >
          Sign out
        </Button>
      </AuthLayout>
    );
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    setBusy(true);
    setError(undefined);
    try {
      const data = new FormData(event.currentTarget);
      await rpcClient.org.create({ name: String(data.get("name")) });
      await Promise.all([session.refetch(), queryClient.invalidateQueries()]);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not create organization");
    } finally {
      setBusy(false);
    }
  }
  return (
    <AuthLayout
      title="Create an organization"
      description="Choose a name for your first organization."
    >
      <form className="space-y-4" onSubmit={create}>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <div className="space-y-2">
          <Label htmlFor="new-org">Organization name</Label>
          <Input id="new-org" name="name" required />
        </div>
        <Button className="w-full" disabled={busy}>
          {busy ? "Creating…" : "Create organization"}
        </Button>
      </form>
    </AuthLayout>
  );
}

export function Loading() {
  return (
    <div className="flex min-h-svh items-center justify-center bg-background">
      <div
        className="size-5 animate-spin rounded-full border-2 border-muted border-t-foreground"
        role="status"
        aria-label="Loading"
      />
    </div>
  );
}
function CenteredError({ error }: { error: Error }) {
  return (
    <div className="flex min-h-svh items-center justify-center p-6">
      <Alert variant="destructive" className="max-w-md">
        <AlertDescription>{error.message}</AlertDescription>
      </Alert>
    </div>
  );
}
