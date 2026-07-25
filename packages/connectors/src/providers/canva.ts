import type { ProviderDefInput } from "#connectors/schema.js";

// Canva's official MCP server requires an allowlisted redirect URI, so its
// broadly available Connect REST API is the transport for this catalog entry.
export const canvaProvider = {
  key: "canva",
  displayName: "Canva",
  description:
    "Create, find, import, export, and upload assets for Canva designs over the Connect REST API.",
  logoUrl: "/connector-logos/canva.svg",
  categories: ["design"],
  docsUrl: "https://www.canva.dev/docs/connect/api-reference/authentication/",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://www.canva.com/api/oauth/authorize",
    tokenUrl: "https://api.canva.com/rest/v1/oauth/token",
    defaultScopes: [
      "asset:read",
      "asset:write",
      "design:content:read",
      "design:content:write",
      "design:meta:read",
    ],
    // Full Canva OAuth scope vocabulary (verbatim from the vendored Nango
    // scope catalog, packages/providers/providers.scopes.yaml, key `canva`).
    availableScopes: [
      "asset:read",
      "asset:write",
      "brandtemplate:content:read",
      "brandtemplate:meta:read",
      "collaboration:event",
      "comment:read",
      "comment:write",
      "design:content:read",
      "design:content:write",
      "design:meta:read",
      "email",
      "folder:permission:write",
      "folder:read",
      "folder:write",
      "openid",
      "profile",
      "profile:read",
    ],
    tokenRequestAuthMethod: "basic",
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.canva.com/rest/v1",
    // No openApiSpecUrl: Canva's official reference is not published as a
    // stable OpenAPI 3 document, so this manifest is hand-curated.
    verification: { method: "GET", endpoints: ["/users/me"] },
  },
  toolManifest: [
    {
      name: "list_designs",
      description: "List designs accessible to the connected Canva user.",
      method: "GET",
      path: "/designs",
      paramsSchema: {
        type: "object",
        properties: {
          continuation: { type: "string" },
          ownership: { type: "string", enum: ["owned", "shared"] },
          query: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_design",
      description: "Get metadata and page information for one Canva design.",
      method: "GET",
      path: "/designs/{designId}",
      paramsSchema: {
        type: "object",
        properties: { designId: { type: "string" } },
        required: ["designId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_design",
      description: "Create a new Canva design from a template or design type.",
      method: "POST",
      path: "/designs",
      paramsSchema: {
        type: "object",
        properties: {
          design_type: { type: "object" },
          title: { type: "string" },
          asset_id: { type: "string" },
        },
      },
      sensitivity: "write",
    },
    {
      name: "create_design_export",
      description: "Start an export job for a Canva design.",
      method: "POST",
      path: "/exports",
      paramsSchema: {
        type: "object",
        properties: { design_id: { type: "string" }, format: { type: "object" } },
        required: ["design_id", "format"],
      },
      sensitivity: "write",
    },
    {
      name: "get_design_export",
      description: "Get the status and download URLs for a Canva export job.",
      method: "GET",
      path: "/exports/{exportId}",
      paramsSchema: {
        type: "object",
        properties: { exportId: { type: "string" } },
        required: ["exportId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_asset_upload_from_url",
      description: "Start a Canva asset upload job from a public URL.",
      method: "POST",
      path: "/url-asset-uploads",
      paramsSchema: {
        type: "object",
        properties: { name: { type: "string" }, url: { type: "string" } },
        required: ["name", "url"],
      },
      sensitivity: "write",
    },
    {
      name: "get_asset_upload_from_url",
      description: "Get the status and resulting asset for a Canva URL upload job.",
      method: "GET",
      path: "/url-asset-uploads/{jobId}",
      paramsSchema: {
        type: "object",
        properties: { jobId: { type: "string" } },
        required: ["jobId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_design_import",
      description: "Start a job to import a design into Canva.",
      method: "POST",
      path: "/imports",
      paramsSchema: {
        type: "object",
        properties: { title: { type: "string" }, url: { type: "string" } },
        required: ["title", "url"],
      },
      sensitivity: "write",
    },
    {
      name: "get_design_import",
      description: "Get the status and resulting design for a Canva import job.",
      method: "GET",
      path: "/imports/{importId}",
      paramsSchema: {
        type: "object",
        properties: { importId: { type: "string" } },
        required: ["importId"],
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
