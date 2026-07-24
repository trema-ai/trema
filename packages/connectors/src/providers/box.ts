import type { ProviderDefInput } from "#/schema.js";

// Box's remote MCP server requires an administrator-configured integration
// before it can connect; the OAuth REST API is available to regular users.
export const boxProvider = {
  key: "box",
  displayName: "Box",
  description: "Search, organize, share, and manage Box files and folders over the REST API.",
  logoUrl: "/connector-logos/box.svg",
  categories: ["productivity"],
  docsUrl: "https://developer.box.com/reference/",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://account.box.com/api/oauth2/authorize",
    tokenUrl: "https://api.box.com/oauth2/token",
    defaultScopes: ["root_readwrite"],
    // Full Box OAuth scope vocabulary (verbatim from Nango's scope catalog).
    availableScopes: [
      "ai.readwrite",
      "enterprise_content",
      "manage_app_users",
      "manage_data_retention",
      "manage_enterprise_properties",
      "manage_groups",
      "manage_legal_holds",
      "manage_managed_users",
      "manage_triggers",
      "manage_webhook",
      "root_readonly",
      "root_readwrite",
      "sign_requests.readwrite",
    ],
    // Box requires the client credentials in the form-encoded token request.
    tokenRequestAuthMethod: "body",
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.box.com",
    // Box's public reference is not published as a stable OpenAPI 3 document.
    verification: { method: "GET", endpoints: ["/2.0/users/me"] },
  },
  toolManifest: [
    {
      name: "search_content",
      description: "Search Box files, folders, and web links by query.",
      method: "GET",
      path: "/2.0/search",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string" },
          type: { type: "string" },
          ancestor_folder_ids: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "get_file",
      description: "Get metadata for a Box file.",
      method: "GET",
      path: "/2.0/files/{fileId}",
      paramsSchema: {
        type: "object",
        properties: { fileId: { type: "string" }, fields: { type: "string" } },
        required: ["fileId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_folder_items",
      description: "List files and folders in a Box folder.",
      method: "GET",
      path: "/2.0/folders/{folderId}/items",
      paramsSchema: {
        type: "object",
        properties: {
          folderId: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
          sort: { type: "string" },
        },
        required: ["folderId"],
      },
      sensitivity: "read",
    },
    {
      name: "get_folder",
      description: "Get metadata for a Box folder.",
      method: "GET",
      path: "/2.0/folders/{folderId}",
      paramsSchema: {
        type: "object",
        properties: { folderId: { type: "string" }, fields: { type: "string" } },
        required: ["folderId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_folder",
      description: "Create a folder in Box.",
      method: "POST",
      path: "/2.0/folders",
      paramsSchema: {
        type: "object",
        properties: { name: { type: "string" }, parent: { type: "object" } },
        required: ["name", "parent"],
      },
      sensitivity: "write",
    },
    {
      name: "update_file",
      description: "Rename, move, or update metadata for a Box file.",
      method: "PUT",
      path: "/2.0/files/{fileId}",
      paramsSchema: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          name: { type: "string" },
          parent: { type: "object" },
          description: { type: "string" },
        },
        required: ["fileId"],
      },
      sensitivity: "write",
    },
    {
      name: "copy_file",
      description: "Copy a Box file into another folder.",
      method: "POST",
      path: "/2.0/files/{fileId}/copy",
      paramsSchema: {
        type: "object",
        properties: {
          fileId: { type: "string" },
          parent: { type: "object" },
          name: { type: "string" },
        },
        required: ["fileId", "parent"],
      },
      sensitivity: "write",
    },
    {
      name: "create_shared_link",
      description: "Create or update the shared link for a Box file.",
      method: "PUT",
      path: "/2.0/files/{fileId}",
      paramsSchema: {
        type: "object",
        properties: { fileId: { type: "string" }, shared_link: { type: "object" } },
        required: ["fileId", "shared_link"],
      },
      sensitivity: "write",
    },
    {
      name: "delete_file",
      description: "Move a Box file to the trash.",
      method: "DELETE",
      path: "/2.0/files/{fileId}",
      paramsSchema: {
        type: "object",
        properties: { fileId: { type: "string" } },
        required: ["fileId"],
      },
      sensitivity: "destructive",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
