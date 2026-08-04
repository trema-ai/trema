import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import { lazy, type ReactNode, Suspense, useRef } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { AdminSettingsPage, SettingsLayout } from "#web/components/trema/settings-layout.tsx";
import { Toaster } from "#web/components/ui/sonner.tsx";
import { authClient, orpc } from "#web/lib/api.ts";
import { AuthenticatedAppShell, AuthenticatedProvider, Loading } from "#web/pages/home.tsx";

// Every page below gets its own chunk, fetched when its route is first
// visited. Imported statically they built one 1.3 MB file, most of which a
// given visit never runs — /gallery alone was half of it. The home page stays
// static: its module carries the authenticated shell and the Loading fallback
// these boundaries suspend to, and its route is the default one.
//
// React.lazy resolves a module's default export and every page here is a named
// one, so each import maps its own name through. The mapping is written out per
// page rather than through a helper, which would erase the props types that
// make these routes type-check.
const AutomationsPage = lazy(() =>
  import("#web/pages/automations.tsx").then((m) => ({ default: m.AutomationsPage })),
);
const BootstrapPage = lazy(() =>
  import("#web/pages/bootstrap.tsx").then((m) => ({ default: m.BootstrapPage })),
);
const CustomizePage = lazy(() =>
  import("#web/pages/customize/index.tsx").then((m) => ({ default: m.CustomizePage })),
);
const Gallery = lazy(() => import("#web/pages/gallery.tsx").then((m) => ({ default: m.Gallery })));
const JoinPage = lazy(() => import("#web/pages/join.tsx").then((m) => ({ default: m.JoinPage })));
const LinkSlackPage = lazy(() =>
  import("#web/pages/link-slack.tsx").then((m) => ({ default: m.LinkSlackPage })),
);
const RunPage = lazy(() =>
  import("#web/pages/runs/detail.tsx").then((m) => ({ default: m.RunPage })),
);
const RunsPage = lazy(() =>
  import("#web/pages/runs/index.tsx").then((m) => ({ default: m.RunsPage })),
);
const ScopesPage = lazy(() =>
  import("#web/pages/scopes.tsx").then((m) => ({ default: m.ScopesPage })),
);
const SettingsAppearancePage = lazy(() =>
  import("#web/pages/settings/appearance.tsx").then((m) => ({
    default: m.SettingsAppearancePage,
  })),
);
const SettingsApprovalsPage = lazy(() =>
  import("#web/pages/settings/approvals.tsx").then((m) => ({ default: m.SettingsApprovalsPage })),
);
const SettingsAuditPage = lazy(() =>
  import("#web/pages/settings/audit.tsx").then((m) => ({ default: m.SettingsAuditPage })),
);
const SettingsCapabilitiesPage = lazy(() =>
  import("#web/pages/settings/capabilities.tsx").then((m) => ({
    default: m.SettingsCapabilitiesPage,
  })),
);
const SettingsConnectorDetailPage = lazy(() =>
  import("#web/pages/settings/connectors/detail.tsx").then((m) => ({
    default: m.SettingsConnectorDetailPage,
  })),
);
const SettingsConnectorsPage = lazy(() =>
  import("#web/pages/settings/connectors/index.tsx").then((m) => ({
    default: m.SettingsConnectorsPage,
  })),
);
const SettingsGeneralPage = lazy(() =>
  import("#web/pages/settings/general.tsx").then((m) => ({ default: m.SettingsGeneralPage })),
);
const SettingsMembersPage = lazy(() =>
  import("#web/pages/settings/members.tsx").then((m) => ({ default: m.SettingsMembersPage })),
);
const SettingsMessagingPage = lazy(() =>
  import("#web/pages/settings/messaging/index.tsx").then((m) => ({
    default: m.SettingsMessagingPage,
  })),
);
const SettingsModelProviderPage = lazy(() =>
  import("#web/pages/settings/models/detail.tsx").then((m) => ({
    default: m.SettingsModelProviderPage,
  })),
);
const SettingsModelsPage = lazy(() =>
  import("#web/pages/settings/models/index.tsx").then((m) => ({ default: m.SettingsModelsPage })),
);
const SettingsPoliciesPage = lazy(() =>
  import("#web/pages/settings/policies.tsx").then((m) => ({ default: m.SettingsPoliciesPage })),
);
const SettingsProfilePage = lazy(() =>
  import("#web/pages/settings/profile.tsx").then((m) => ({ default: m.SettingsProfilePage })),
);
const SignInPage = lazy(() =>
  import("#web/pages/sign-in.tsx").then((m) => ({ default: m.SignInPage })),
);

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
    // One boundary around the whole table: only the matched route suspends,
    // and it falls back to the same Loading the initial config fetch shows.
    <Suspense fallback={<Loading />}>
      <Routes>
        <Route
          path="/sign-in"
          element={
            <SignInPage
              providers={config.data.providers}
              legal={config.data.legal}
              openSignup={config.data.openSignup}
            />
          }
        />
        <Route
          path="/bootstrap"
          element={
            <BootstrapPage
              needsBootstrap={config.data.needsBootstrap}
              providers={config.data.providers}
              legal={config.data.legal}
              openSignup={config.data.openSignup}
            />
          }
        />
        <Route path="/join" element={<JoinPage />} />
        <Route path="/link/slack" element={<LinkSlackPage />} />
        <Route path="/gallery" element={shell(<Gallery />)} />
        <Route path="/automations" element={shell(<AutomationsPage />)} />
        <Route path="/runs" element={shell(<RunsPage />)} />
        <Route path="/runs/:id" element={shell(<RunPage />)} />
        <Route path="/customize" element={shell(<CustomizePage />)} />
        <Route path="/context" element={<Navigate to="/customize" replace />} />
        <Route path="/scopes" element={<Navigate to="/settings/scopes" replace />} />
        <Route path="/settings" element={settings(<Navigate to="/settings/profile" replace />)} />
        <Route path="/settings/profile" element={settings(<SettingsProfilePage />)} />
        <Route path="/settings/appearance" element={settings(<SettingsAppearancePage />)} />
        <Route path="/settings/general" element={settings(<SettingsGeneralPage />, true)} />
        <Route path="/settings/members" element={settings(<SettingsMembersPage />, true)} />
        <Route path="/settings/messaging" element={settings(<SettingsMessagingPage />, true)} />
        <Route path="/settings/scopes" element={settings(<ScopesPage />, true)} />
        <Route path="/settings/connectors" element={settings(<SettingsConnectorsPage />, true)} />
        <Route
          path="/settings/capabilities"
          element={settings(<SettingsCapabilitiesPage />, true)}
        />
        <Route path="/settings/policies" element={settings(<SettingsPoliciesPage />, true)} />
        <Route path="/settings/approvals" element={settings(<SettingsApprovalsPage />, true)} />
        <Route path="/settings/models" element={settings(<SettingsModelsPage />, true)} />
        <Route path="/settings/audit" element={settings(<SettingsAuditPage />, true)} />
        <Route
          path="/settings/connectors/:providerKey"
          element={settings(<SettingsConnectorDetailPage />, true)}
        />
        <Route
          path="/settings/models/:providerName"
          element={settings(<SettingsModelProviderPage />, true)}
        />
        <Route path="/settings/*" element={settings(<Navigate to="/settings/profile" replace />)} />
        <Route path="/" element={<Navigate to="/runs" replace />} />
        <Route path="*" element={<Navigate to="/runs" replace />} />
      </Routes>
    </Suspense>
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
