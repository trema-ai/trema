import { defineConfig } from "blume";

export default defineConfig({
  title: "Trema",
  description: "Documentation for Trema, the AI agent your company owns.",
  logo: {
    // The Trema lockup (mark plus wordmark) as SVG outlines, the same art the
    // marketing site header uses. The paths fill with `currentColor`, so Blume
    // inlines the file and the logo follows the light and dark theme. `text` is
    // empty because the wordmark already carries the "Trema" lettering.
    image: "/logo.svg",
    text: "",
  },
  content: {
    root: "docs",
  },
  openapi: {
    // Render the server's OpenAPI spec as an interactive API reference. The
    // `dev`, `build`, and `sync:spec` scripts copy `apps/server/openapi.json`
    // to `openapi.json` here first. Refresh the source with
    // `pnpm --filter @trema/server openapi`.
    enabled: true,
    route: "/api",
    spec: "openapi.json",
  },
  navigation: {
    tabs: [{ label: "API", path: "/api" }],
  },
  deployment: {
    // `site` is the origin; `base` layers the /docs subdirectory onto every
    // route and asset URL, so the built site serves from trema.so/docs.
    output: "static",
    site: "https://trema.so",
    base: "/docs",
  },
  ai: {
    // Emit llms.txt and llms-full.txt alongside the per-page .md mirrors.
    llmsTxt: true,
  },
});
