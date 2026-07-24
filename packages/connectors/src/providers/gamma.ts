import type { ProviderDefInput } from "#/schema.js";

// Gamma's hosted MCP server requires requesting custom MCP access. Its
// documented Generate API is broadly available and is the self-service option.
export const gammaProvider = {
  key: "gamma",
  displayName: "Gamma",
  description: "Generate presentations, documents, webpages, and social content with Gamma.",
  logoUrl: "/connector-logos/gamma.svg",
  categories: ["productivity"],
  docsUrl: "https://developers.gamma.app/api-reference/introduction",
  authMode: "api_key",
  auth: { defaultScopes: [] },
  configFields: {},
  credentialFields: {
    apiKey: {
      type: "string",
      title: "API key",
      description: "A Gamma API key created in the Gamma developer settings.",
      pattern: "^sk-gamma-",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: "https://public-api.gamma.app",
    authHeader: `x-api-key: \${credentials.apiKey}`,
    // Gamma publishes a reference, rather than a stable OpenAPI 3 document.
    verification: { method: "GET", endpoints: ["/v1.0/folders"] },
  },
  toolManifest: [
    {
      name: "generate_presentation",
      description: "Generate a Gamma presentation from a prompt or source content.",
      method: "POST",
      path: "/v1.0/generations",
      paramsSchema: {
        type: "object",
        properties: {
          inputText: { type: "string" },
          format: { type: "string", enum: ["presentation"] },
          themeId: { type: "string" },
          title: { type: "string" },
        },
        required: ["inputText", "format"],
      },
      sensitivity: "write",
    },
    {
      name: "generate_document",
      description: "Generate a Gamma document from a prompt or source content.",
      method: "POST",
      path: "/v1.0/generations",
      paramsSchema: {
        type: "object",
        properties: {
          inputText: { type: "string" },
          format: { type: "string", enum: ["document"] },
          themeId: { type: "string" },
          title: { type: "string" },
        },
        required: ["inputText", "format"],
      },
      sensitivity: "write",
    },
    {
      name: "generate_webpage",
      description: "Generate a Gamma webpage from a prompt or source content.",
      method: "POST",
      path: "/v1.0/generations",
      paramsSchema: {
        type: "object",
        properties: {
          inputText: { type: "string" },
          format: { type: "string", enum: ["webpage"] },
          themeId: { type: "string" },
          title: { type: "string" },
        },
        required: ["inputText", "format"],
      },
      sensitivity: "write",
    },
    {
      name: "generate_social_post",
      description: "Generate a social-media post in Gamma from a prompt or source content.",
      method: "POST",
      path: "/v1.0/generations",
      paramsSchema: {
        type: "object",
        properties: {
          inputText: { type: "string" },
          format: { type: "string", enum: ["social"] },
          themeId: { type: "string" },
          title: { type: "string" },
        },
        required: ["inputText", "format"],
      },
      sensitivity: "write",
    },
    {
      name: "generate_from_template",
      description: "Generate Gamma content from an existing template.",
      method: "POST",
      path: "/v1.0/generations/from-template",
      paramsSchema: {
        type: "object",
        properties: {
          templateId: { type: "string" },
          inputText: { type: "string" },
          title: { type: "string" },
        },
        required: ["templateId", "inputText"],
      },
      sensitivity: "write",
    },
    {
      name: "get_generation",
      description: "Get a Gamma generation's status and resulting content URL.",
      method: "GET",
      path: "/v1.0/generations/{generationId}",
      paramsSchema: {
        type: "object",
        properties: { generationId: { type: "string" } },
        required: ["generationId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_themes",
      description: "List themes available for Gamma generation requests.",
      method: "GET",
      path: "/v1.0/themes",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
    {
      name: "list_folders",
      description: "List folders available to the Gamma account.",
      method: "GET",
      path: "/v1.0/folders",
      paramsSchema: { type: "object", properties: {} },
      sensitivity: "read",
    },
  ],
  memberConnectable: false,
} satisfies ProviderDefInput;
