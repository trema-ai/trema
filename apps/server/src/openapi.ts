import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";

import { router } from "./router.js";

// Path prefix the public REST API mounts under. The generated spec lists it as
// the single server URL, so operation paths stay relative to it.
export const OPENAPI_PREFIX = "/api/v1";

// The public REST API version. Bump this when the surface changes in a way that
// breaks existing clients.
export const OPENAPI_VERSION = "1.0.0";

const generator = new OpenAPIGenerator({
  // The router builds its schemas with Zod v4, so the generator needs the
  // matching converter to turn them into JSON Schema.
  schemaConverters: [new ZodToJsonSchemaConverter()],
});

// Build the OpenAPI document for the public REST API. The output is
// deterministic for a given router, so a build can write it to a file or a
// server can serve it once at startup.
export function generateOpenApiDocument() {
  return generator.generate(router, {
    info: {
      title: "Trema API",
      version: OPENAPI_VERSION,
      description: "The public REST API for Trema, the AI agent your company owns.",
    },
    servers: [{ url: OPENAPI_PREFIX }],
    // The tag order and descriptions drive the docs sidebar sections. Every
    // route's `tags` must name one of these.
    tags: [
      {
        name: "System",
        description: "Health and liveness checks for the API surface.",
      },
      {
        name: "Configuration",
        description: "Public deployment and sign-in settings.",
      },
      {
        name: "Bootstrap",
        description: "First-run setup for a dedicated deployment.",
      },
      {
        name: "Organizations",
        description: "Create, list, and switch the active organization.",
      },
      {
        name: "Members",
        description: "Organization membership, roles, and invites.",
      },
    ],
  });
}
