import { env } from "#server/lib/env/index.js";
import { serveRunWorker } from "#server/worker.js";

// The process entry for the run worker, next to the server's. Production runs
// `trema worker`, which takes its configuration from the real environment;
// this entry exists so the watch-mode worker reads the same .env file the
// server does in local development.
await serveRunWorker({ env });
