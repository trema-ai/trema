import { bootstrapRouter } from "./rpc/bootstrap.js";
import { configRouter } from "./rpc/config.js";
import { orgRouter } from "./rpc/org.js";
import { systemRouter } from "./rpc/system.js";

export const router = {
  bootstrap: bootstrapRouter,
  config: configRouter,
  org: orgRouter,
  system: systemRouter,
};

export type Router = typeof router;
