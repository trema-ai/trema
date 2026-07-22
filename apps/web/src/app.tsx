import { QueryClient, QueryClientProvider, useQuery } from "@tanstack/react-query";
import { ThemeProvider } from "next-themes";
import type { ReactNode } from "react";
import { BrowserRouter, Navigate, Route, Routes, useLocation } from "react-router";
import { Toaster } from "#/components/ui/sonner.tsx";
import { authClient, orpc } from "#/lib/api.ts";
import { BootstrapPage } from "#/pages/bootstrap.tsx";
import { Gallery } from "#/pages/gallery.tsx";
import { AuthenticatedShell, HomePage, Loading } from "#/pages/home.tsx";
import { JoinPage } from "#/pages/join.tsx";
import { ScopesPage } from "#/pages/scopes.tsx";
import { SignInPage } from "#/pages/sign-in.tsx";

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, staleTime: 15_000 } },
});

function AppRoutes() {
  const config = useQuery(orpc.config.get.queryOptions({}));
  const session = authClient.useSession();
  const location = useLocation();
  if (config.isPending || session.isPending) return <Loading />;
  if (config.error)
    return (
      <main className="flex min-h-svh items-center justify-center p-6 text-sm text-destructive">
        {config.error.message}
      </main>
    );
  if (config.data.needsBootstrap && location.pathname !== "/bootstrap")
    return <Navigate to="/bootstrap" replace />;
  const shell = (content: ReactNode) => (
    <AuthenticatedShell mode={config.data.mode}>{content}</AuthenticatedShell>
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
      <Route path="/scopes" element={shell(<ScopesPage />)} />
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
