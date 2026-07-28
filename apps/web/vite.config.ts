import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Per-worktree dev ports from scripts/dev-env.sh (via mise); defaults apply
// when the dev server runs outside mise.
const serverPort = Number(process.env.TREMA_SERVER_PORT ?? 3000);
const webPort = Number(process.env.TREMA_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
  build: {
    rollupOptions: {
      output: {
        // React and the router move only on a dependency bump. Left in the
        // entry chunk they would be re-downloaded on every deploy, so they get
        // a chunk whose hash survives app changes. These are the specifiers the
        // app actually imports: a chunk is seeded from the module a name
        // resolves to, so naming the package root would leave `react-dom/client`
        // — where the bulk of the renderer lives — back in the entry.
        manualChunks: {
          react: ["react", "react/jsx-runtime", "react-dom/client", "react-router"],
        },
      },
    },
  },
  server: {
    port: webPort,
    // The server's TREMA_WEB_ORIGINS allowlist names this exact origin, so
    // fail instead of silently drifting to the next free port.
    strictPort: true,
    proxy: {
      "/api": `http://localhost:${serverPort}`,
      "/rpc": `http://localhost:${serverPort}`,
    },
  },
});
