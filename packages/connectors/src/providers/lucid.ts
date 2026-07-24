import type { ProviderDefInput } from "#/schema.js";

// Lucid's MCP is a developer-documentation server, not a workspace-data API,
// so this provider uses the production REST API for documents and folders.
export const lucidProvider = {
  key: "lucid",
  displayName: "Lucid",
  description: "Search, create, organize, and share Lucid documents and folders over the REST API.",
  logoUrl: "/connector-logos/lucid.svg",
  categories: ["design"],
  docsUrl: "https://developer.lucid.co/reference/documents",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://lucid.app/oauth2/authorize",
    tokenUrl: "https://api.lucid.co/oauth2/token",
    defaultScopes: [
      "lucidchart.document.content",
      "lucidspark.document.content",
      "folder",
      "user.profile",
      "offline_access",
    ],
    tokenRequestAuthMethod: "body",
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.lucid.co",
    // Lucid embeds OpenAPI 3 fragments in its per-endpoint documentation, but
    // does not publish one stable aggregate specification for this curation.
    verification: { method: "GET", endpoints: ["/v1/users/me/profile"] },
  },
  toolManifest: [
    {
      name: "get_current_user",
      description: "Get the profile for the connected Lucid user.",
      method: "GET",
      path: "/v1/users/me/profile",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
    {
      name: "search_documents",
      description: "Search documents accessible to the connected Lucid user.",
      method: "POST",
      path: "/v1/documents/search",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          product: { type: "array", items: { type: "string" } },
          pageSize: { type: "integer" },
          pageToken: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_document",
      description: "Get metadata or export information for a Lucid document.",
      method: "GET",
      path: "/v1/documents/{id}",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" }, format: { type: "string" } },
        required: ["id"],
      },
      sensitivity: "read",
    },
    {
      name: "get_document_content",
      description: "Get the structured content of a Lucidchart or Lucidspark document.",
      method: "GET",
      path: "/v1/documents/{id}/contents",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sensitivity: "read",
    },
    {
      name: "create_document",
      description: "Create a new Lucidchart or Lucidspark document.",
      method: "POST",
      path: "/v1/documents",
      paramsSchema: {
        type: "object",
        properties: {
          title: { type: "string" },
          product: { type: "string", enum: ["lucidchart", "lucidspark"] },
          parent: { type: "string" },
          content: { type: "object" },
        },
        required: ["title", "product"],
      },
      sensitivity: "write",
    },
    {
      name: "update_document",
      description: "Update a Lucid document's title, folder, or classification.",
      method: "PATCH",
      path: "/v1/documents/{id}",
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          title: { type: "string" },
          parent: { type: "string" },
          classification: { type: "string" },
        },
        required: ["id"],
      },
      sensitivity: "write",
    },
    {
      name: "list_root_folder_contents",
      description: "List the documents and folders in the connected user's Lucid root folder.",
      method: "GET",
      path: "/v1/folders/root/contents",
      paramsSchema: {
        type: "object",
        properties: { pageSize: { type: "integer" }, pageToken: { type: "string" } },
      },
      sensitivity: "read",
    },
    {
      name: "create_folder",
      description: "Create a Lucid folder.",
      method: "POST",
      path: "/v1/folders",
      paramsSchema: {
        type: "object",
        properties: { title: { type: "string" }, parent: { type: "string" } },
        required: ["title"],
      },
      sensitivity: "write",
    },
    {
      name: "get_folder",
      description: "Get metadata for a Lucid folder.",
      method: "GET",
      path: "/v1/folders/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sensitivity: "read",
    },
    {
      name: "trash_document",
      description: "Move a Lucid document to the trash.",
      method: "DELETE",
      path: "/v1/documents/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
      sensitivity: "destructive",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
