import { os } from "@orpc/server";
import { z } from "zod";

import type { Database } from "./db.js";

export interface RpcContext {
  db: Database;
  headers: Headers;
}

const procedure = os.$context<RpcContext>();

const ping = procedure
  .output(
    z.object({
      ok: z.literal(true),
      time: z.date(),
    }),
  )
  .handler(() => ({
    ok: true as const,
    time: new Date(),
  }));

export const router = {
  system: {
    ping,
  },
};

export type Router = typeof router;
