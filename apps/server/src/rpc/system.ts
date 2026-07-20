import { z } from "zod";

import { pub } from "./builders.js";

const ping = pub
  .route({
    method: "GET",
    path: "/system/ping",
    summary: "Liveness check over the API surface",
  })
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

export const systemRouter = {
  ping,
};
