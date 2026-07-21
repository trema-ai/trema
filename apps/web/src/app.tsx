import { ThemeProvider } from "next-themes";

import { AppShell } from "#/components/trema/app-shell.tsx";
import { Toaster } from "#/components/ui/sonner.tsx";
import { Gallery } from "#/pages/gallery.tsx";

export function App() {
  return (
    <ThemeProvider attribute="class" defaultTheme="system" enableSystem>
      <AppShell>
        <Gallery />
      </AppShell>
      <Toaster />
    </ThemeProvider>
  );
}
