import { describe, expect, it } from "vitest";
import {
  connectorCategoryOptions,
  filterConnectorRows,
} from "#web/pages/settings/connectors/filters.tsx";
import type { CatalogProvider } from "#web/pages/settings/connectors/shared.tsx";

function provider(key: string, displayName: string, categories: string[]): CatalogProvider {
  return {
    key,
    displayName,
    description: "",
    categories,
    docsUrl: "https://example.com",
    authMode: "oauth2_code",
    transport: { type: "rest" },
    supportsPersonalOAuth: true,
    configFields: {},
    credentialFields: {},
    toolManifest: [],
    defaultScopes: [],
    availableScopes: [],
  };
}

const linear = provider("linear", "Linear", ["project-management"]);
const stripe = provider("stripe", "Stripe", ["payments"]);

describe("connector catalog filters", () => {
  it("fuzzy-matches and ranks provider fields", () => {
    const rows = filterConnectorRows({
      rows: [stripe, linear],
      search: "lnear",
      category: "all",
      providerOf: (row) => row,
    });

    expect(rows.map((row) => row.key)).toEqual(["linear"]);
  });

  it("matches account labels supplied by a connector view", () => {
    const rows = filterConnectorRows({
      rows: [
        { provider: linear, account: "Acme workspace" },
        { provider: stripe, account: "Billing" },
      ],
      search: "acme",
      category: "all",
      providerOf: (row) => row.provider,
      extraFieldsOf: (row) => [row.account],
    });

    expect(rows.map((row) => row.provider.key)).toEqual(["linear"]);
  });

  it("normalizes category values and labels", () => {
    const options = connectorCategoryOptions([
      provider("hubspot", "HubSpot", ["CRM"]),
      provider("apollo", "Apollo", ["crm"]),
    ]);

    expect(options).toEqual([
      { value: "all", label: "All categories" },
      { value: "crm", label: "CRM" },
    ]);
  });
});
