import type { ProviderDefInput } from "#/schema.js";

// DocuSign's official MCP server is currently open beta, so the production
// eSignature REST API provides this catalog entry.
export const docusignProvider = {
  key: "docusign",
  displayName: "DocuSign",
  description:
    "Create, send, view, and manage DocuSign envelopes and recipients over the eSignature REST API.",
  logoUrl: "/connector-logos/docusign.svg",
  categories: ["productivity"],
  docsUrl: "https://developers.docusign.com/docs/esign-rest-api/",
  authMode: "oauth2_code",
  auth: {
    authorizationUrl: "https://account.docusign.com/oauth/auth",
    tokenUrl: "https://account.docusign.com/oauth/token",
    defaultScopes: ["signature", "extended"],
    tokenRequestAuthMethod: "basic",
  },
  configFields: {
    accountId: {
      type: "string",
      title: "Account ID",
      description: "The DocuSign account ID for the eSignature operations.",
      example: "a1234567-b89c-012d-e345-6789abcdef01",
    },
  },
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: "https://www.docusign.net/restapi/v2.1",
    // DocuSign publishes API references but no single stable public OpenAPI 3 document.
    verification: { method: "GET", endpoints: [`/accounts/\${config.accountId}`] },
  },
  toolManifest: [
    {
      name: "list_envelopes",
      description: "List envelopes in a DocuSign account.",
      method: "GET",
      path: "/accounts/{accountId}/envelopes",
      paramsSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          from_date: { type: "string" },
          status: { type: "string" },
          count: { type: "integer" },
          start_position: { type: "integer" },
        },
        required: ["accountId"],
      },
      sensitivity: "read",
    },
    {
      name: "get_envelope",
      description: "Get one DocuSign envelope.",
      method: "GET",
      path: "/accounts/{accountId}/envelopes/{envelopeId}",
      paramsSchema: {
        type: "object",
        properties: { accountId: { type: "string" }, envelopeId: { type: "string" } },
        required: ["accountId", "envelopeId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_envelope",
      description: "Create a DocuSign envelope in draft or sent status.",
      method: "POST",
      path: "/accounts/{accountId}/envelopes",
      paramsSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          emailSubject: { type: "string" },
          documents: { type: "array", items: { type: "object" } },
          recipients: { type: "object" },
          status: { type: "string", enum: ["created", "sent"] },
        },
        required: ["accountId", "emailSubject", "recipients", "status"],
      },
      sensitivity: "write",
    },
    {
      name: "send_envelope",
      description: "Send a draft DocuSign envelope.",
      method: "PUT",
      path: "/accounts/{accountId}/envelopes/{envelopeId}",
      paramsSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          envelopeId: { type: "string" },
          status: { type: "string", enum: ["sent"] },
        },
        required: ["accountId", "envelopeId", "status"],
      },
      sensitivity: "write",
    },
    {
      name: "void_envelope",
      description: "Void a DocuSign envelope.",
      method: "PUT",
      path: "/accounts/{accountId}/envelopes/{envelopeId}",
      paramsSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          envelopeId: { type: "string" },
          status: { type: "string", enum: ["voided"] },
          voidedReason: { type: "string" },
        },
        required: ["accountId", "envelopeId", "status"],
      },
      sensitivity: "destructive",
    },
    {
      name: "list_recipients",
      description: "List the recipients for a DocuSign envelope.",
      method: "GET",
      path: "/accounts/{accountId}/envelopes/{envelopeId}/recipients",
      paramsSchema: {
        type: "object",
        properties: { accountId: { type: "string" }, envelopeId: { type: "string" } },
        required: ["accountId", "envelopeId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_documents",
      description: "List documents in a DocuSign envelope.",
      method: "GET",
      path: "/accounts/{accountId}/envelopes/{envelopeId}/documents",
      paramsSchema: {
        type: "object",
        properties: { accountId: { type: "string" }, envelopeId: { type: "string" } },
        required: ["accountId", "envelopeId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_recipient_view",
      description: "Create an embedded signing URL for a DocuSign recipient.",
      method: "POST",
      path: "/accounts/{accountId}/envelopes/{envelopeId}/views/recipient",
      paramsSchema: {
        type: "object",
        properties: {
          accountId: { type: "string" },
          envelopeId: { type: "string" },
          returnUrl: { type: "string" },
          authenticationMethod: { type: "string" },
          email: { type: "string" },
          userName: { type: "string" },
          clientUserId: { type: "string" },
        },
        required: [
          "accountId",
          "envelopeId",
          "returnUrl",
          "authenticationMethod",
          "email",
          "userName",
          "clientUserId",
        ],
      },
      sensitivity: "write",
    },
  ],
  memberConnectable: true,
} satisfies ProviderDefInput;
