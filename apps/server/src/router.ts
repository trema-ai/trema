import { systemRouter } from "./rpc/system.js";

export const router = {
  system: systemRouter,
};

export type Router = typeof router;
