import type { ProviderDefInput } from "#/schema.js";

// Connects one Stripe account with a restricted API key. Nango's "stripe"
// entry is Stripe Connect OAuth for platform apps — the wrong shape for an
// org connecting its own account, so this uses api_key mode instead.
export const stripeProvider = {
  key: "stripe",
  displayName: "Stripe",
  description:
    "A curated set of tools to read customers, invoices, and payments over the Stripe REST API.",
  logoUrl: "/connector-logos/stripe.svg",
  categories: ["payments"],
  docsUrl: "https://docs.stripe.com/keys",
  authMode: "api_key",
  auth: {
    defaultScopes: [],
  },
  configFields: {},
  credentialFields: {
    apiKey: {
      type: "string",
      title: "API key",
      description: "A restricted Stripe API key with read access to the resources the agent needs.",
      pattern: "^rk_|^sk_",
      secret: true,
    },
  },
  transport: {
    type: "rest",
    baseUrl: "https://api.stripe.com",
    authHeader: `Bearer \${credentials.apiKey}`,
    openApiSpecUrl: "https://raw.githubusercontent.com/stripe/openapi/master/openapi/spec3.json",
    verification: { method: "GET", endpoints: ["/v1/balance"] },
  },
  toolManifest: [
    {
      name: "search_customers",
      description: "Search Stripe customers with Stripe's search query language.",
      method: "GET",
      path: "/v1/customers/search",
      paramsSchema: {
        type: "object",
        properties: {
          query: { type: "string", description: "e.g. email:'ada@example.com'." },
          limit: { type: "integer" },
          page: { type: "string", description: "Paging cursor from a previous search." },
        },
        required: ["query"],
      },
      sensitivity: "read",
    },
    {
      name: "get_customer",
      description: "Get one Stripe customer by id.",
      method: "GET",
      path: "/v1/customers/{customerId}",
      paramsSchema: {
        type: "object",
        properties: { customerId: { type: "string" } },
        required: ["customerId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_invoices",
      description: "List Stripe invoices, optionally filtered by customer or status.",
      method: "GET",
      path: "/v1/invoices",
      paramsSchema: {
        type: "object",
        properties: {
          customer: { type: "string" },
          status: { type: "string", enum: ["draft", "open", "paid", "uncollectible", "void"] },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "list_payment_intents",
      description: "List Stripe payment intents, optionally filtered by customer.",
      method: "GET",
      path: "/v1/payment_intents",
      paramsSchema: {
        type: "object",
        properties: {
          customer: { type: "string" },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "list_subscriptions",
      description: "List Stripe subscriptions, optionally filtered by customer, status, or price.",
      method: "GET",
      path: "/v1/subscriptions",
      paramsSchema: {
        type: "object",
        properties: {
          customer: { type: "string" },
          status: {
            type: "string",
            enum: ["active", "past_due", "unpaid", "canceled", "trialing", "paused", "all"],
          },
          price: { type: "string", description: "Only subscriptions on this price id." },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_subscription",
      description: "Get one Stripe subscription by id.",
      method: "GET",
      path: "/v1/subscriptions/{subscriptionId}",
      paramsSchema: {
        type: "object",
        properties: { subscriptionId: { type: "string" } },
        required: ["subscriptionId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_charges",
      description: "List Stripe charges, optionally filtered by customer or payment intent.",
      method: "GET",
      path: "/v1/charges",
      paramsSchema: {
        type: "object",
        properties: {
          customer: { type: "string" },
          payment_intent: { type: "string" },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_charge",
      description: "Get one Stripe charge by id.",
      method: "GET",
      path: "/v1/charges/{chargeId}",
      paramsSchema: {
        type: "object",
        properties: { chargeId: { type: "string" } },
        required: ["chargeId"],
      },
      sensitivity: "read",
    },
    {
      name: "create_refund",
      // destructive: moves money back to the customer, not reversible.
      description: "Refund a Stripe charge or payment intent, fully or partially.",
      method: "POST",
      path: "/v1/refunds",
      paramsSchema: {
        type: "object",
        properties: {
          charge: { type: "string", description: "Id of the charge to refund." },
          payment_intent: { type: "string", description: "Id of the payment intent to refund." },
          amount: {
            type: "integer",
            description: "Amount to refund in the smallest currency unit; omit to refund in full.",
          },
          reason: {
            type: "string",
            enum: ["duplicate", "fraudulent", "requested_by_customer"],
          },
        },
      },
      sensitivity: "destructive",
    },
    {
      name: "list_products",
      description: "List Stripe products in the catalog.",
      method: "GET",
      path: "/v1/products",
      paramsSchema: {
        type: "object",
        properties: {
          active: { type: "boolean" },
          ids: { type: "array", items: { type: "string" }, description: "Only these product ids." },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "list_prices",
      description: "List Stripe prices, optionally filtered by product.",
      method: "GET",
      path: "/v1/prices",
      paramsSchema: {
        type: "object",
        properties: {
          product: { type: "string" },
          active: { type: "boolean" },
          currency: { type: "string" },
          type: { type: "string", enum: ["one_time", "recurring"] },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "get_invoice",
      description: "Get one Stripe invoice by id.",
      method: "GET",
      path: "/v1/invoices/{invoiceId}",
      paramsSchema: {
        type: "object",
        properties: { invoiceId: { type: "string" } },
        required: ["invoiceId"],
      },
      sensitivity: "read",
    },
    {
      name: "list_balance_transactions",
      description:
        "List Stripe balance transactions — the funds flowing through the account balance.",
      method: "GET",
      path: "/v1/balance_transactions",
      paramsSchema: {
        type: "object",
        properties: {
          type: { type: "string", description: "Filter by transaction type, e.g. charge, refund." },
          payout: { type: "string", description: "Only transactions paid out in this payout." },
          limit: { type: "integer" },
          starting_after: { type: "string" },
        },
      },
      sensitivity: "read",
    },
    {
      name: "create_customer",
      description: "Create a Stripe customer.",
      method: "POST",
      path: "/v1/customers",
      paramsSchema: {
        type: "object",
        properties: {
          email: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          description: { type: "string" },
          metadata: { type: "object", description: "Arbitrary key-value metadata." },
        },
      },
      sensitivity: "write",
    },
    {
      name: "update_customer",
      description: "Update a Stripe customer's details.",
      method: "POST",
      path: "/v1/customers/{customerId}",
      paramsSchema: {
        type: "object",
        properties: {
          customerId: { type: "string" },
          email: { type: "string" },
          name: { type: "string" },
          phone: { type: "string" },
          description: { type: "string" },
          metadata: { type: "object", description: "Arbitrary key-value metadata." },
        },
        required: ["customerId"],
      },
      sensitivity: "write",
    },
  ],
  memberConnectable: false,
} satisfies ProviderDefInput;
