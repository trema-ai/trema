import { bootstrapRouter } from "./rpc/bootstrap.js";
import { configRouter } from "./rpc/config.js";
import { serviceCredentialsRouter } from "./rpc/credentials.js";
import { membersRouter } from "./rpc/members.js";
import { orgRouter } from "./rpc/org.js";
import { systemRouter } from "./rpc/system.js";

export const router = {
  bootstrap: bootstrapRouter,
  config: configRouter,
  members: membersRouter,
  org: orgRouter,
  serviceCredentials: serviceCredentialsRouter,
  system: systemRouter,
};

export type Router = typeof router;
