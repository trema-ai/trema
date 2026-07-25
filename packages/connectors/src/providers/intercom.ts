import type { ProviderDefInput } from "#connectors/schema.js";

// Intercom's official MCP server is limited to US-hosted workspaces. The REST
// API supports US, EU, and AU workspaces, so it is the org-capable transport.
export const intercomProvider = {
  key: "intercom",
  displayName: "Intercom",
  description:
    "Search contacts and conversations, reply to customers, and manage support work over the Intercom REST API.",
  logoUrl: "/connector-logos/intercom.svg",
  categories: ["support"],
  docsUrl:
    "https://developers.intercom.com/docs/build-an-integration/learn-more/authentication/setting-up-oauth",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: `https://\${config.authorizationHost}/oauth`,
    tokenUrl: `https://\${config.apiHost}/auth/eagle/token`,
    defaultScopes: [],
    // Intercom permissions are selected when creating the OAuth app, rather
    // than passed as OAuth scope strings during authorization.
    tokenRequestAuthMethod: "body",
  },
  configFields: {
    authorizationHost: {
      type: "string",
      title: "Authorization host",
      description: "The Intercom host that matches the workspace region.",
      enum: ["app.intercom.com", "app.eu.intercom.com", "app.au.intercom.com"],
      default: "app.intercom.com",
    },
    apiHost: {
      type: "string",
      title: "API host",
      description: "The Intercom API host that matches the workspace region.",
      enum: ["api.intercom.io", "api.eu.intercom.io", "api.au.intercom.io"],
      default: "api.intercom.io",
    },
  },
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: `https://\${config.apiHost}`,
    // No openApiSpecUrl: Intercom's official reference is not published as a
    // stable OpenAPI 3 document, so this manifest is hand-curated.
    retry: { atHeaders: ["x-ratelimit-reset"] },
    verification: { method: "GET", endpoints: ["/me"] },
  },
  toolManifest: [
    {
      name: "search_contacts",
      description: "Search contacts with an Intercom contact query.",
      method: "POST",
      path: "/contacts/search",
      paramsSchema: {
        type: "object",
        properties: { query: { type: "object" }, pagination: { type: "object" } },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "get_contact",
      description: "Get one Intercom contact by id.",
      method: "GET",
      path: "/contacts/{contactId}",
      paramsSchema: {
        type: "object",
        properties: { contactId: { type: "string" } },
        required: ["contactId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_contact",
      description: "Create a new Intercom contact.",
      method: "POST",
      path: "/contacts",
      paramsSchema: {
        type: "object",
        properties: {
          role: { type: "string", enum: ["lead", "user"] },
          email: { type: "string" },
          external_id: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          custom_attributes: { type: "object" },
        },
        required: ["role"],
      },
      sensitivity: "write",
    },
    {
      name: "update_contact",
      description: "Update an Intercom contact's attributes.",
      method: "PUT",
      path: "/contacts/{contactId}",
      paramsSchema: {
        type: "object",
        properties: {
          contactId: { type: "string" },
          email: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          custom_attributes: { type: "object" },
        },
        required: ["contactId"],
      },
      sensitivity: "write",
    },
    {
      name: "list_conversations",
      description: "List conversations in the Intercom workspace.",
      method: "GET",
      path: "/conversations",
      paramsSchema: {
        type: "object",
        properties: { per_page: { type: "integer" }, starting_after: { type: "string" } },
      },
      sensitivity: "read",
    },
    {
      name: "get_conversation",
      description: "Get one Intercom conversation by id.",
      method: "GET",
      path: "/conversations/{conversationId}",
      paramsSchema: {
        type: "object",
        properties: { conversationId: { type: "string" } },
        required: ["conversationId"],
      },
      sensitivity: "read",
    },
    {
      name: "reply_to_conversation",
      description: "Add an admin reply or note to an Intercom conversation.",
      method: "POST",
      path: "/conversations/{conversationId}/reply",
      paramsSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          type: { type: "string", enum: ["admin", "user"] },
          admin_id: { type: "string" },
          message_type: { type: "string", enum: ["comment", "note"] },
          body: { type: "string" },
        },
        required: ["conversationId", "type", "message_type", "body"],
      },
      sensitivity: "write",
    },
    {
      name: "manage_conversation",
      description: "Assign, close, reopen, or snooze an Intercom conversation.",
      method: "POST",
      path: "/conversations/{conversationId}/parts",
      paramsSchema: {
        type: "object",
        properties: {
          conversationId: { type: "string" },
          message_type: { type: "string", enum: ["assignment", "close", "open", "snoozed"] },
          type: { type: "string", enum: ["admin", "team"] },
          admin_id: { type: "string" },
          assignee_id: { type: "string" },
          snoozed_until: { type: "integer" },
        },
        required: ["conversationId", "message_type"],
      },
      sensitivity: "write",
    },
    {
      name: "list_tags",
      description: "List tags available in the Intercom workspace.",
      method: "GET",
      path: "/tags",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
