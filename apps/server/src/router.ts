import { bindingsRouter } from "./rpc/bindings.js";
import { bootstrapRouter } from "./rpc/bootstrap.js";
import { configRouter } from "./rpc/config.js";
import { connectorsRouter } from "./rpc/connectors.js";
import { serviceCredentialsRouter } from "./rpc/credentials.js";
import { itemsRouter } from "./rpc/items.js";
import { membersRouter } from "./rpc/members.js";
import { orgRouter } from "./rpc/org.js";
import { scopesRouter } from "./rpc/scopes.js";
import { surfacesRouter } from "./rpc/surfaces.js";
import { systemRouter } from "./rpc/system.js";

export const router = {
  bootstrap: bootstrapRouter,
  bindings: bindingsRouter,
  config: configRouter,
  connectors: connectorsRouter,
  members: membersRouter,
  items: itemsRouter,
  org: orgRouter,
  scopes: scopesRouter,
  serviceCredentials: serviceCredentialsRouter,
  system: systemRouter,
  surfaces: surfacesRouter,
};

export type Router = typeof router;
