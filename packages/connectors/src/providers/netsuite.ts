import type { ProviderDefInput } from "#connectors/schema.js";

// NetSuite MCP is an account-installed SuiteApp with an account-specific
// service endpoint; this portable OAuth connector uses SuiteTalk REST instead.
export const netsuiteProvider = {
  key: "netsuite",
  trusted: true,
  displayName: "NetSuite",
  description:
    "Manage NetSuite customers, sales orders, invoices, and other records through SuiteTalk REST.",
  logoUrl: "/connector-logos/netsuite.svg",
  categories: ["productivity"],
  docsUrl:
    "https://docs.oracle.com/en/cloud/saas/netsuite/ns-online-help/section_157780312610.html",
  authMode: "oauth2_code",
  oauthActor: "user",
  auth: {
    authorizationUrl: `https://\${config.accountId}.app.netsuite.com/app/login/oauth2/authorize.nl`,
    tokenUrl: `https://\${config.accountId}.suitetalk.api.netsuite.com/services/rest/auth/oauth2/v1/token`,
    defaultScopes: ["rest_webservices"],
    availableScopes: ["rest_webservices"],
    authorizationParams: { prompt: "consent" },
  },
  configFields: {
    accountId: {
      type: "string",
      title: "Account ID",
      description: "The NetSuite account ID used in the SuiteTalk REST hostname.",
      example: "tstdrv231585",
      pattern: "^[a-zA-Z0-9_-]+$",
    },
  },
  credentialFields: {},
  transport: {
    type: "rest",
    baseUrl: `https://\${config.accountId}.suitetalk.api.netsuite.com/services/rest/record/v1`,
    // NetSuite generates OpenAPI 3 metadata per account and record type; it has no public portable spec URL.
    retry: { afterHeaders: ["retry-after"] },
    verification: { method: "GET", endpoints: ["/metadata-catalog?select=customer"] },
  },
  toolManifest: [
    {
      name: "list_customers",
      description: "List NetSuite customer records.",
      method: "GET",
      path: "/customer",
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          offset: { type: "integer" },
          q: { type: "string" },
        },
      },
    },
    {
      name: "get_customer",
      description: "Get a NetSuite customer record.",
      method: "GET",
      path: "/customer/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "create_customer",
      description: "Create a NetSuite customer record.",
      method: "POST",
      path: "/customer",
      paramsSchema: {
        type: "object",
        properties: {
          companyName: { type: "string" },
          firstName: { type: "string" },
          lastName: { type: "string" },
          email: { type: "string" },
          subsidiary: { type: "object" },
        },
        required: ["companyName"],
      },
    },
    {
      name: "update_customer",
      description: "Update a NetSuite customer record.",
      method: "PATCH",
      path: "/customer/{id}",
      paramsSchema: {
        type: "object",
        properties: {
          id: { type: "string" },
          companyName: { type: "string" },
          email: { type: "string" },
          phone: { type: "string" },
        },
        required: ["id"],
      },
    },
    {
      name: "list_sales_orders",
      description: "List NetSuite sales orders.",
      method: "GET",
      path: "/salesOrder",
      paramsSchema: {
        type: "object",
        properties: {
          limit: { type: "integer" },
          offset: { type: "integer" },
          q: { type: "string" },
        },
      },
    },
    {
      name: "get_sales_order",
      description: "Get a NetSuite sales order.",
      method: "GET",
      path: "/salesOrder/{id}",
      paramsSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
    },
    {
      name: "create_sales_order",
      description: "Create a NetSuite sales order.",
      method: "POST",
      path: "/salesOrder",
      paramsSchema: {
        type: "object",
        properties: {
          entity: { type: "object" },
          item: { type: "object" },
          memo: { type: "string" },
          subsidiary: { type: "object" },
        },
        required: ["entity", "item"],
      },
    },
    {
      name: "update_sales_order",
      description: "Update a NetSuite sales order.",
      method: "PATCH",
      path: "/salesOrder/{id}",
      paramsSchema: {
        type: "object",
        properties: { id: { type: "string" }, memo: { type: "string" }, item: { type: "object" } },
        required: ["id"],
      },
    },
    {
      name: "delete_record",
      description: "Delete a NetSuite record by type and internal id.",
      method: "DELETE",
      path: "/{recordType}/{id}",
      paramsSchema: {
        type: "object",
        properties: { recordType: { type: "string" }, id: { type: "string" } },
        required: ["recordType", "id"],
      },
    },
  ],
} satisfies ProviderDefInput;
