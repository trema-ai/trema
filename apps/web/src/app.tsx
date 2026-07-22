import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { type ReactNode, useRef } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AdminSettingsPage, SettingsLayout } from "#/components/trema/settings-layout.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { authClient, orpc } from "#/lib/api.ts";
import { AutomationsPage } from "#/pages/automations.tsx";
import { BootstrapPage } from "#/pages/bootstrap.tsx";
import { ContextPage } from "#/pages/context.tsx";
import { Gallery } from "#/pages/gallery.tsx";
import { AuthenticatedAppShell, AuthenticatedProvider, HomePage, Loading } from "#/pages/home.tsx";
import { JoinPage } from "#/pages/join.tsx";
import { ScopesPage } from "#/pages/scopes.tsx";
import { SettingsAppearancePage } from "#/pages/settings-appearance.tsx";
import { SettingsGeneralPage } from "#/pages/settings-general.tsx";
import { SettingsMembersPage } from "#/pages/settings-members.tsx";
import { SettingsProfilePage } from "#/pages/settings-profile.tsx";
import { SignInPage } from "#/pages/sign-in.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
});

function AppRoutes() {
  const config = useQuery(orpc.config.get.queryOptions({}));
  const session = authClient.useSession();
  const location = useLocation();
  // A signed-out session flips isPending back to true on every focus-triggered
  // refetch; gating on it after first settle would remount the route tree and
  // wipe form state, so Loading only covers the initial load.
  const sessionSettled = useRef(false);
  if (!session.isPending) sessionSettled.current = true;
  if (config.isPending || (session.isPending && !sessionSettled.current)) return <Loading />;
  if (config.error)
    return (
      <main className="flex min-h-svh items-center justify-center p-6 text-sm text-destructive">
        {config.error.message}
      </main>
    );
  if (config.data.needsBootstrap && location.pathname !== "/bootstrap")
    return <Navigate to="/bootstrap" replace />;
  const shell = (content: ReactNode) => (
    <AuthenticatedProvider mode={config.data.mode}>
      <AuthenticatedAppShell>{content}</AuthenticatedAppShell>
    </AuthenticatedProvider>
  );
  const settings = (content: ReactNode, admin = false) => (
    <AuthenticatedProvider mode={config.data.mode}>
      <SettingsLayout>
        {admin ? <AdminSettingsPage>{content}</AdminSettingsPage> : content}
      </SettingsLayout>
    </AuthenticatedProvider>
  );
  return (
    <Routes>
      <Route
        path="/sign-in"
        element={<SignInPage providers={config.data.providers} legal={config.data.legal} />}
      />
      <Route
        path="/bootstrap"
        element={
          <BootstrapPage
            needsBootstrap={config.data.needsBootstrap}
            providers={config.data.providers}
            legal={config.data.legal}
          />
        }
      />
      <Route path="/join" element={<JoinPage />} />
      <Route path="/gallery" element={shell(<Gallery />)} />
      <Route path="/automations" element={shell(<AutomationsPage />)} />
      <Route path="/context" element={shell(<ContextPage />)} />
      <Route path="/scopes" element={<Navigate to="/settings/scopes" replace />} />
      <Route path="/settings" element={settings(<Navigate to="/settings/profile" replace />)} />
      <Route path="/settings/profile" element={settings(<SettingsProfilePage />)} />
      <Route path="/settings/appearance" element={settings(<SettingsAppearancePage />)} />
      <Route path="/settings/general" element={settings(<SettingsGeneralPage />, true)} />
      <Route path="/settings/members" element={settings(<SettingsMembersPage />, true)} />
      <Route path="/settings/scopes" element={settings(<ScopesPage />, true)} />
      <Route path="/settings/*" element={settings(<Navigate to="/settings/profile" replace />)} />
      <Route path="/" element={shell(<HomePage />)} />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <AppRoutes />
        </BrowserRouter>
      </QueryClientProvider>
      <Toaster />
    </ThemeProvider>
  );
}
