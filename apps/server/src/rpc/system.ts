import { z } from "zod";

import { pub } from "./builders.js";

const ping = pub
  .route({
    method: "GET",
    path: "/system/ping",
    summary: "Liveness check over the API surface",
    description:
      "Confirm the API is reachable and read the server's current time.",
    tags: ["System"],
  })
  .output(
    z
      .object({
        ok: z
          .literal(true)
          .describe("Always true when the API is reachable."),
        time: z
          .date()
          .describe("The server's current time. An ISO 8601 date-time."),
      })
      .describe("The liveness status and the server's current time."),
  )
  .handler(() => ({
    ok: true as const,
    time: new Date(),
  }));

export const systemRouter = {
  ping,
};
