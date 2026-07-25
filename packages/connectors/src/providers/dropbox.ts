import type { ProviderDefInput } from "#connectors/schema.js";

export const dropboxProvider = {
  key: "dropbox",
  displayName: "Dropbox",
  description: "Search, organize, move, and share Dropbox files and folders over the REST API.",
  logoUrl: "/connector-logos/dropbox.svg",
  categories: ["productivity"],
  docsUrl: "https://www.dropbox.com/developers/documentation/http/documentation",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://www.dropbox.com/oauth2/authorize",
    tokenUrl: "https://api.dropboxapi.com/oauth2/token",
    defaultScopes: [],
    authorizationParams: { token_access_type: "offline" },
  },
  configFields: {},
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://api.dropboxapi.com",
    // Dropbox documents its HTTP API but no stable OpenAPI 3 document.
    verification: { method: "POST", endpoints: ["/2/users/get_current_account"], body: {} },
  },
  toolManifest: [
    {
      name: "get_current_account",
      description: "Get the account associated with the connected Dropbox token.",
      method: "POST",
      path: "/2/users/get_current_account",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
    {
      name: "search_files",
      description: "Search Dropbox files and folders by query.",
      method: "POST",
      path: "/2/files/search_v2",
      paramsSchema: {
        type: "object",
        properties: { query: { type: "string" }, options: { type: "object" } },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "get_metadata",
      description: "Get metadata for a Dropbox file or folder.",
      method: "POST",
      path: "/2/files/get_metadata",
      paramsSchema: {
        type: "object",
        properties: { path: { type: "string" }, include_deleted: { type: "boolean" } },
        required: ["path"],
      },
      sensitivity: "read",
    },
    {
      name: "list_folder",
      description: "List the contents of a Dropbox folder.",
      method: "POST",
      path: "/2/files/list_folder",
      paramsSchema: {
        type: "object",
        properties: {
          path: { type: "string" },
          recursive: { type: "boolean" },
          limit: { type: "integer" },
          include_deleted: { type: "boolean" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "create_folder",
      description: "Create a Dropbox folder.",
      method: "POST",
      path: "/2/files/create_folder_v2",
      paramsSchema: {
        type: "object",
        properties: { path: { type: "string" }, autorename: { type: "boolean" } },
        required: ["path"],
      },
      sensitivity: "write",
    },
    {
      name: "move_file_or_folder",
      description: "Move or rename a Dropbox file or folder.",
      method: "POST",
      path: "/2/files/move_v2",
      paramsSchema: {
        type: "object",
        properties: {
          from_path: { type: "string" },
          to_path: { type: "string" },
          autorename: { type: "boolean" },
        },
        required: ["from_path", "to_path"],
      },
      sensitivity: "write",
    },
    {
      name: "copy_file_or_folder",
      description: "Copy a Dropbox file or folder.",
      method: "POST",
      path: "/2/files/copy_v2",
      paramsSchema: {
        type: "object",
        properties: {
          from_path: { type: "string" },
          to_path: { type: "string" },
          autorename: { type: "boolean" },
        },
        required: ["from_path", "to_path"],
      },
      sensitivity: "write",
    },
    {
      name: "create_shared_link",
      description: "Create a shared link for a Dropbox file or folder.",
      method: "POST",
      path: "/2/sharing/create_shared_link_with_settings",
      paramsSchema: {
        type: "object",
        properties: { path: { type: "string" }, settings: { type: "object" } },
        required: ["path"],
      },
      sensitivity: "write",
    },
    {
      name: "delete_file_or_folder",
      description: "Delete a Dropbox file or folder.",
      method: "POST",
      path: "/2/files/delete_v2",
      paramsSchema: {
        type: "object",
        properties: { path: { type: "string" } },
        required: ["path"],
      },
      sensitivity: "destructive",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
