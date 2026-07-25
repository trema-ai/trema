import { auditRouter } from "./rpc/audit.js";
import { bindingsRouter } from "./rpc/bindings.js";
import { bootstrapRouter } from "./rpc/bootstrap.js";
import { configRouter } from "./rpc/config.js";
import { connectorsRouter } from "./rpc/connectors.js";
import { serviceCredentialsRouter } from "./rpc/credentials.js";
import { embeddingsRouter } from "./rpc/embeddings.js";
import { itemsRouter } from "./rpc/items.js";
import { membersRouter } from "./rpc/members.js";
import { orgRouter } from "./rpc/org.js";
import { runsRouter } from "./rpc/runs.js";
import { schedulesRouter } from "./rpc/schedules.js";
import { scopesRouter } from "./rpc/scopes.js";
import { searchRouter } from "./rpc/search.js";
import { sessionsRouter } from "./rpc/sessions.js";
import { surfacesRouter } from "./rpc/surfaces.js";
import { systemRouter } from "./rpc/system.js";

export const router = {
  bootstrap: bootstrapRouter,
  audit: auditRouter,
  bindings: bindingsRouter,
  config: configRouter,
  connectors: connectorsRouter,
  embeddings: embeddingsRouter,
  members: membersRouter,
  items: itemsRouter,
  org: orgRouter,
  runs: runsRouter,
  schedules: schedulesRouter,
  scopes: scopesRouter,
  search: searchRouter,
  serviceCredentials: serviceCredentialsRouter,
  sessions: sessionsRouter,
  system: systemRouter,
  surfaces: surfacesRouter,
};

export type Router = typeof router;
