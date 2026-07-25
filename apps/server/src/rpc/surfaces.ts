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
  })
  .describe("An integration-backed surface that can provide bindable locations.");

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
