import { approvalsRouter } from "./rpc/approvals.js";
import { auditRouter } from "./rpc/audit.js";
import { bindingsRouter } from "./rpc/bindings.js";
import { bootstrapRouter } from "./rpc/bootstrap.js";
import { configRouter } from "./rpc/config.js";
import { connectorsRouter } from "./rpc/connectors.js";
import { serviceCredentialsRouter } from "./rpc/credentials.js";
import { intentsRouter } from "./rpc/intents.js";
import { itemsRouter } from "./rpc/items.js";
import { membersRouter } from "./rpc/members.js";
import { modelProvidersRouter } from "./rpc/model-providers.js";
import { orgRouter } from "./rpc/org.js";
import { policiesRouter } from "./rpc/policies.js";
import { schedulesRouter } from "./rpc/schedules.js";
import { scopesRouter } from "./rpc/scopes.js";
import { searchRouter } from "./rpc/search.js";
import { sessionsRouter } from "./rpc/sessions.js";
import { surfacesRouter } from "./rpc/surfaces.js";
import { systemRouter } from "./rpc/system.js";

export const router = {
  bootstrap: bootstrapRouter,
  approvals: approvalsRouter,
  audit: auditRouter,
  bindings: bindingsRouter,
  config: configRouter,
  connectors: connectorsRouter,
  intents: intentsRouter,
  members: membersRouter,
  items: itemsRouter,
  modelProviders: modelProvidersRouter,
  org: orgRouter,
  policies: policiesRouter,
  schedules: schedulesRouter,
  scopes: scopesRouter,
  search: searchRouter,
  serviceCredentials: serviceCredentialsRouter,
  sessions: sessionsRouter,
  system: systemRouter,
  surfaces: surfacesRouter,
};

export type Router = typeof router;
