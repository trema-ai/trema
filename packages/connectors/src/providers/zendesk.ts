import type { ProviderDefInput } from "#connectors/schema.js";

export const zendeskProvider = {
  key: "zendesk",
  displayName: "Zendesk",
  description: "Search, read, and update support tickets in a Zendesk instance.",
  logoUrl: "/connector-logos/zendesk.svg",
  categories: ["support"],
  docsUrl:
    "https://developer.zendesk.com/documentation/ticketing/working-with-oauth/creating-and-using-oauth-tokens-with-the-api/",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: `https://\${config.subdomain}.zendesk.com/oauth/authorizations/new`,
    tokenUrl: `https://\${config.subdomain}.zendesk.com/oauth/tokens`,
    defaultScopes: ["read", "write"],
    // Full Zendesk OAuth scope vocabulary (verbatim from the vendored Nango
    // scope catalog, packages/providers/providers.scopes.yaml, key `zendesk`).
    availableScopes: [
      "any_channel:write",
      "apps:read",
      "apps:write",
      "auditlogs:read",
      "automations:read",
      "automations:write",
      "dynamic_content:read",
      "dynamic_content:write",
      "hc:read",
      "hc:write",
      "impersonate",
      "macros:read",
      "macros:write",
      "organizations:read",
      "organizations:write",
      "read",
      "requests:read",
      "requests:write",
      "satisfaction_ratings:read",
      "satisfaction_ratings:write",
      "targets:read",
      "targets:write",
      "tickets:read",
      "tickets:write",
      "triggers:read",
      "triggers:write",
      "unrestricted:read",
      "unrestricted:write",
      "users:read",
      "users:write",
      "web_widget:write",
      "webhooks:read",
      "webhooks:write",
      "write",
    ],
  },
  configFields: {
    subdomain: {
      type: "string",
      title: "Zendesk subdomain",
      description: "The subdomain of the Zendesk instance.",
      pattern: "^[a-z0-9_-]+$",
      example: "acme",
      prefix: "https://",
      suffix: ".zendesk.com",
    },
  },
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: `https://\${config.subdomain}.zendesk.com`,
    // No openApiSpecUrl: Zendesk publishes no official OpenAPI spec for the core
    // Support API, so this manifest is hand-curated.
    retry: { afterHeaders: ["retry-after"] },
    verification: { method: "GET", endpoints: ["/api/v2/users/me.json"] },
  },
  toolManifest: [
    {
      name: "search",
      description: "Search tickets, users, and organizations with Zendesk search syntax.",
      method: "GET",
      path: "/api/v2/search.json",
      paramsSchema: {
        type: "object",
        properties: {
          query: {
            type: "string",
            description: "Zendesk search query, e.g. 'type:ticket status:open'.",
          },
          sort_by: { type: "string" },
          sort_order: { type: "string", enum: ["asc", "desc"] },
        },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "get_ticket",
      description: "Get one Zendesk ticket by id.",
      method: "GET",
      path: "/api/v2/tickets/{ticketId}.json",
      paramsSchema: {
        type: "object",
        properties: { ticketId: { type: "integer" } },
        required: ["ticketId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_ticket_comments",
      description: "List the comment thread of a Zendesk ticket.",
      method: "GET",
      path: "/api/v2/tickets/{ticketId}/comments.json",
      paramsSchema: {
        type: "object",
        properties: { ticketId: { type: "integer" } },
        required: ["ticketId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_ticket",
      description: "Create a new Zendesk ticket.",
      method: "POST",
      path: "/api/v2/tickets.json",
      paramsSchema: {
        type: "object",
        properties: {
          ticket: {
            type: "object",
            description: "Ticket payload: subject, comment.body, priority, requester_id, tags.",
          },
        },
        required: ["ticket"],
      },
      sensitivity: "write",
    },
    {
      name: "update_ticket",
      description: "Update a Zendesk ticket: add a comment, change status, priority, or assignee.",
      method: "PUT",
      path: "/api/v2/tickets/{ticketId}.json",
      paramsSchema: {
        type: "object",
        properties: {
          ticketId: { type: "integer" },
          ticket: {
            type: "object",
            description:
              "Fields to change; use comment.body for a reply, comment.public=false for an internal note.",
          },
        },
        required: ["ticketId", "ticket"],
      },
      sensitivity: "write",
    },
    {
      name: "search_users",
      description: "Search Zendesk users by name, email, or other attributes.",
      method: "GET",
      path: "/api/v2/users/search.json",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "Name, email, or Zendesk user search query." },
        },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "get_user",
      description: "Get one Zendesk user by id.",
      method: "GET",
      path: "/api/v2/users/{userId}.json",
      paramsSchema: {
        type: "object",
        properties: { userId: { type: "integer" } },
        required: ["userId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_organizations",
      description: "List the organizations in a Zendesk instance.",
      method: "GET",
      path: "/api/v2/organizations.json",
      paramsSchema: {
        type: "object",
        properties: { page: { type: "integer" }, per_page: { type: "integer" } },
      },
      sensitivity: "read",
    },
    {
      name: "get_organization",
      description: "Get one Zendesk organization by id.",
      method: "GET",
      path: "/api/v2/organizations/{organizationId}.json",
      paramsSchema: {
        type: "object",
        properties: { organizationId: { type: "integer" } },
        required: ["organizationId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_views",
      description: "List the ticket views defined in a Zendesk instance.",
      method: "GET",
      path: "/api/v2/views.json",
      paramsSchema: {
        type: "object",
        properties: { page: { type: "integer" }, per_page: { type: "integer" } },
      },
      sensitivity: "read",
    },
    {
      name: "list_tickets_from_view",
      description: "List the tickets that match a Zendesk view.",
      method: "GET",
      path: "/api/v2/views/{viewId}/tickets.json",
      paramsSchema: {
        type: "object",
        properties: {
          viewId: { type: "integer" },
          page: { type: "integer" },
          per_page: { type: "integer" },
        },
        required: ["viewId"],
      },
      sensitivity: "read",
    },
  ],
  memberConnectable: false,
} satisfies ProviderDefInput;
