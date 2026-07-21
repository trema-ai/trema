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
      description: [
        "The public REST API for Trema, the AI agent your company owns.",
        "",
        "## Authentication",
        "",
        "The API accepts two kinds of credentials:",
        "",
        "- **Session cookie** — for browsers and interactive clients. Sign in through the auth endpoints under `/api/auth/*` to receive the session cookie. Organization-scoped operations act as the signed-in member of the active organization.",
        "- **Service credential** — for machines. An administrator creates one with `POST /service-credentials` and receives the secret once. Send it as `Authorization: Bearer trema_sc_...`. The token acts as the principal it is bound to.",
        "",
        "Each operation lists the scheme it accepts. Operations that list no scheme are public.",
      ].join("\n"),
    },
    servers: [{ url: OPENAPI_PREFIX }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "better-auth.session_token",
          description:
            "The session cookie set by sign-in. Over HTTPS the cookie name carries the `__Secure-` prefix.",
        },
        serviceCredential: {
          type: "http",
          scheme: "bearer",
          bearerFormat: "trema_sc_…",
          description:
            "An organization-scoped service credential. The secret is shown once at creation and acts as the principal the credential is bound to.",
        },
      },
    },
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
      {
        name: "Service credentials",
        description: "Machine credentials for calling Trema as an organization principal.",
      },
    ],
  });
}
