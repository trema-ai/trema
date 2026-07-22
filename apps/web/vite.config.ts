import { fileURLToPath } from "node:url";
import tailwindcss from "@tailwindcss/vite";
import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    proxy: {
      "/api": "http://localhost:3000",
      "/rpc": "http://localhost:3000",
    },
  },
  resolve: {
    alias: {
      "#": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
