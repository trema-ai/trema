import { defineConfig } from "blume";

export default defineConfig({
  title: "Trema",
  description: "Documentation for Trema, the AI agent your company owns.",
  content: {
    root: "docs",
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
