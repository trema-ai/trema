import { configureLogger } from "../src/lib/logger/index.js";

// Instrumentation runs during tests too, and a request-per-test log would bury
// the reporter's output. Tests that assert on logging pass their own logger.
configureLogger({ TREMA_LOG_FORMAT: "logfmt", TREMA_LOG_LEVEL: "silent" });
