import type { ProviderDefInput } from "#connectors/schema.js";

export const posthogProvider = {
  key: "posthog",
  trusted: true,
  displayName: "PostHog",
  description:
    "Read product analytics people, events, cohorts, and insights over the PostHog REST API.",
  logoUrl: "/connector-logos/posthog.svg",
  categories: ["developer-tools"],
  docsUrl: "https://posthog.com/docs/api",
  authMode: "api_key",
  auth: { defaultScopes: [] },
  configFields: {
    subdomain: {
      type: "string",
      title: "Cloud region",
      description: "The PostHog Cloud hostname prefix for the connected project.",
      enum: ["us", "us.i", "eu", "eu.i"],
      example: "us",
    },
  },
  credentialFields: {
    apiKey: {
      type: "string",
      title: "Personal API key",
      description: "A PostHog personal API key with access to the project data the agent needs.",
      pattern: "^phx_[A-Za-z0-9]+$",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: `https://\${config.subdomain}.posthog.com`,
    authHeader: `Bearer \${credentials.apiKey}`,
    // No openApiSpecUrl: PostHog serves its API schema per deployment rather
    // than publishing one stable public OpenAPI 3 document.
    verification: { method: "GET", endpoints: ["/api/users/@me"] },
  },
  toolManifest: [
    {
      name: "get_current_user",
      description: "Get the PostHog user associated with the personal API key.",
      method: "GET",
      path: "/api/users/@me",
      paramsSchema: { type: "object", properties: {} },
    },
    {
      name: "list_projects",
      description: "List projects in a PostHog organization.",
      method: "GET",
      path: "/api/organizations/{organizationId}/projects",
      paramsSchema: {
        type: "object",
        properties: {
          organizationId: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["organizationId"],
      },
    },
    {
      name: "list_persons",
      description: "List people in a PostHog project, optionally filtered by email or search.",
      method: "GET",
      path: "/api/projects/{projectId}/persons",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          email: { type: "string" },
          search: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_event_definitions",
      description: "List event definitions in a PostHog project.",
      method: "GET",
      path: "/api/projects/{projectId}/event_definitions",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          search: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_cohorts",
      description: "List cohorts in a PostHog project.",
      method: "GET",
      path: "/api/projects/{projectId}/cohorts",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          search: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "list_insights",
      description: "List saved insights in a PostHog project.",
      method: "GET",
      path: "/api/projects/{projectId}/insights",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          basic: { type: "boolean" },
          refresh: { type: "string" },
          limit: { type: "integer" },
          offset: { type: "integer" },
        },
        required: ["projectId"],
      },
    },
    {
      name: "get_insight",
      description: "Get one saved PostHog insight.",
      method: "GET",
      path: "/api/projects/{projectId}/insights/{insightId}",
      paramsSchema: {
        type: "object",
        properties: { projectId: { type: "string" }, insightId: { type: "string" } },
        required: ["projectId", "insightId"],
      },
    },
    {
      name: "create_insight",
      description: "Create a saved insight in a PostHog project.",
      method: "POST",
      path: "/api/projects/{projectId}/insights",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          name: { type: "string" },
          query: { type: "object" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["projectId", "query"],
      },
    },
    {
      name: "update_insight",
      description: "Update a saved PostHog insight.",
      method: "PATCH",
      path: "/api/projects/{projectId}/insights/{insightId}",
      paramsSchema: {
        type: "object",
        properties: {
          projectId: { type: "string" },
          insightId: { type: "string" },
          name: { type: "string" },
          query: { type: "object" },
          description: { type: "string" },
          tags: { type: "array", items: { type: "string" } },
        },
        required: ["projectId", "insightId"],
      },
    },
  ],
} satisfies ProviderDefInput;
