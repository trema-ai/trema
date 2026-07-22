import { bindingsRouter } from "./rpc/bindings.js";
import { bootstrapRouter } from "./rpc/bootstrap.js";
import { configRouter } from "./rpc/config.js";
import { serviceCredentialsRouter } from "./rpc/credentials.js";
import { membersRouter } from "./rpc/members.js";
import { orgRouter } from "./rpc/org.js";
import { scopesRouter } from "./rpc/scopes.js";
import { systemRouter } from "./rpc/system.js";

export const router = {
  bootstrap: bootstrapRouter,
  bindings: bindingsRouter,
  config: configRouter,
  members: membersRouter,
  org: orgRouter,
  scopes: scopesRouter,
  serviceCredentials: serviceCredentialsRouter,
  system: systemRouter,
};

export type Router = typeof router;
