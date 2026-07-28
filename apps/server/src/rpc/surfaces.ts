import { z } from "zod";

import { surfaceCatalog } from "#server/services/surfaces/index.js";
import { requireCapability } from "./builders.js";

const surfaceSchema = z
  .object({
    id: z.string().describe("The surface's stable identifier."),
    name: z.string().describe("The surface's display name."),
    status: z
      .enum(["planned", "available"])
      .describe("Whether the surface is planned or available through an installed integration."),
    builtIn: z
      .boolean()
      .describe(
        "Whether the surface ships with the deployment instead of arriving with an installed integration.",
      ),
    locationBindable: z
      .boolean()
      .describe(
        "Whether the surface's locations can be bound to a scope. A surface that is not location-bindable resolves implicitly and has nothing to pick: web chat is one location per member, resolving to that member's personal scope.",
      ),
  })
  .describe("A surface that can carry conversations, and how its locations reach a scope.");

const list = requireCapability("read")
  .route({
    method: "GET",
    path: "/surfaces",
    summary: "List surfaces",
    description: "List the catalog of integration-backed surfaces and their availability.",
    tags: ["Surfaces"],
  })
  .output(z.array(surfaceSchema).describe("The surface catalog."))
  .handler(() => [...surfaceCatalog]);

export const surfacesRouter = { list };
