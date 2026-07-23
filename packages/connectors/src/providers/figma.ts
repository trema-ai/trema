import type { ProviderDefInput } from "#/schema.js";

export const figmaProvider = {
  key: "figma",
  displayName: "Figma",
  description:
    "A curated set of tools to read files, browse team projects, and read and post file comments over the Figma REST API.",
  logoUrl: "/connector-logos/figma.svg",
  categories: ["design"],
  docsUrl: "https://www.figma.com/developers/api",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://www.figma.com/oauth",
    tokenUrl: "https://api.figma.com/v1/oauth/token",
    refreshUrl: "https://api.figma.com/v1/oauth/refresh",
    defaultScopes: ["files:read", "file_comments:write"],
    // Full Figma OAuth scope vocabulary (verbatim from the vendored Nango scope
    // catalog, packages/providers/providers.scopes.yaml, key `figma`).
    availableScopes: [
      "current_user:read",
      "file_comments:read",
      "file_comments:write",
      "file_content:read",
      "file_dev_resources:read",
      "file_dev_resources:write",
      "file_metadata:read",
      "file_variables:read",
      "file_variables:write",
      "file_versions:read",
      "files:read",
      "library_analytics:read",
      "library_assets:read",
      "library_content:read",
      "org:activity_log_read",
      "org:ai_metering_usage_read",
      "org:developer_log_read",
      "org:discovery_read",
      "project_metadata:read",
      "projects:read",
      "selections:read",
      "team_library_content:read",
      "webhooks:read",
      "webhooks:write",
    ],
    scopeSeparator: ",",
    // Figma exchanges the code with HTTP Basic client authentication and does
    // not support PKCE.
    tokenRequestAuthMethod: "basic",
    pkce: false,
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.figma.com",
    openApiSpecUrl:
      "https://raw.githubusercontent.com/figma/rest-api-spec/main/openapi/openapi.yaml",
    verification: { method: "GET", endpoints: ["/v1/me"] },
  },
  toolManifest: [
    {
      name: "get_file",
      description: "Get the document tree and metadata for a Figma file by key.",
      method: "GET",
      path: "/v1/files/{fileKey}",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
        },
        required: ["fileKey"],
      },
      sensitivity: "read",
    },
    {
      name: "get_file_comments",
      description: "List the comments on a Figma file.",
      method: "GET",
      path: "/v1/files/{fileKey}/comments",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
        },
        required: ["fileKey"],
      },
      sensitivity: "read",
    },
    {
      name: "post_comment",
      description: "Post a comment on a Figma file, optionally pinned to a location.",
      method: "POST",
      path: "/v1/files/{fileKey}/comments",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
          message: { type: "string", description: "Comment text." },
          client_meta: {
            type: "object",
            description: "Optional anchor: a canvas position or a frame-relative offset.",
          },
        },
        required: ["fileKey", "message"],
      },
      sensitivity: "write",
    },
    {
      name: "get_team_projects",
      description: "List the projects in a Figma team.",
      method: "GET",
      path: "/v1/teams/{teamId}/projects",
      paramsSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team id from a Figma team URL." },
        },
        required: ["teamId"],
      },
      sensitivity: "read",
    },
    {
      name: "get_project_files",
      description: "List the files in a Figma project.",
      method: "GET",
      path: "/v1/projects/{projectId}/files",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string", description: "Project id from get_team_projects." },
        },
        required: ["projectId"],
      },
      sensitivity: "read",
    },
    {
      name: "get_file_nodes",
      description: "Get the document subtree and properties for specific nodes in a Figma file.",
      method: "GET",
      path: "/v1/files/{fileKey}/nodes",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
          ids: { type: "string", description: "Comma-separated node ids to retrieve." },
          version: { type: "string", description: "A specific version id; omit for the latest." },
          depth: { type: "integer", description: "How many levels of each node's tree to return." },
          geometry: { type: "string", description: "Set to 'paths' to include vector geometry." },
        },
        required: ["fileKey", "ids"],
      },
      sensitivity: "read",
    },
    {
      name: "get_image_renders",
      description: "Render specific Figma file nodes as images and return their URLs.",
      method: "GET",
      path: "/v1/images/{fileKey}",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
          ids: { type: "string", description: "Comma-separated node ids to render." },
          scale: { type: "number", description: "Image scale between 0.01 and 4." },
          format: { type: "string", enum: ["jpg", "png", "svg", "pdf"] },
          version: { type: "string", description: "A specific version id; omit for the latest." },
        },
        required: ["fileKey", "ids"],
      },
      sensitivity: "read",
    },
    {
      name: "get_file_versions",
      description: "List the saved version history of a Figma file.",
      method: "GET",
      path: "/v1/files/{fileKey}/versions",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
        },
        required: ["fileKey"],
      },
      sensitivity: "read",
    },
    {
      name: "get_team_components",
      description: "List the published components in a Figma team's library.",
      method: "GET",
      path: "/v1/teams/{teamId}/components",
      paramsSchema: {
        type: "object",
        properties: {
          teamId: { type: "string", description: "Team id from a Figma team URL." },
          page_size: { type: "integer", description: "Items per page (max 1000)." },
          after: { type: "integer", description: "Pagination cursor from a previous page." },
        },
        required: ["teamId"],
      },
      sensitivity: "read",
    },
    {
      name: "get_comment_reactions",
      description: "List the reactions on a comment in a Figma file.",
      method: "GET",
      path: "/v1/files/{fileKey}/comments/{commentId}/reactions",
      paramsSchema: {
        type: "object",
        properties: {
          fileKey: { type: "string", description: "File key from a Figma file URL." },
          commentId: { type: "string", description: "Id of the comment." },
          cursor: { type: "string", description: "Pagination cursor from a previous page." },
        },
        required: ["fileKey", "commentId"],
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
