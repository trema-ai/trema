import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Per-worktree dev ports from scripts/dev-env.sh (via mise); defaults apply
// when the dev server runs outside mise.
const serverPort = Number(process.env.TREMA_SERVER_PORT ?? 3000);
const webPort = Number(process.env.TREMA_WEB_PORT ?? 5173);

export default defineConfig({
  plugins: [react(), tailwindcss()],
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
