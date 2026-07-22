import { describe, expect, it } from "vitest";

import { loadProviderCatalog } from "#/services/connectors/catalog.js";
import {
  createConnectorInstallationBodySchema,
  resolveInstallationTools,
} from "#/services/connectors/installations.js";
import { githubProvider } from "#/services/connectors/providers/github.js";
import { notionMcpProvider } from "#/services/connectors/providers/notion-mcp.js";
import type { ProviderDef } from "#/services/connectors/schema.js";

const catalog = loadProviderCatalog([githubProvider, notionMcpProvider]);
const bodySchema = createConnectorInstallationBodySchema(catalog);
const github = catalog.find(({ key }) => key === "github")!;
const notion = catalog.find(({ key }) => key === "notion")!;

describe("connector installation body", () => {
  it("accepts valid REST and pre/post-sync MCP bodies", () => {
    expect(
      bodySchema.safeParse({ catalogKey: "github", enabledTools: ["get_issue"] }).success,
    ).toBe(true);
    expect(bodySchema.safeParse({ catalogKey: "notion", enabledTools: "all" }).success).toBe(true);
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        enabledTools: ["search_pages"],
        syncedTools: [{ name: "search_pages", sensitivity: "read" }],
      }).success,
    ).toBe(true);
  });

  it("rejects synced tools on REST and unknown catalog keys", () => {
    expect(
      bodySchema.safeParse({
        catalogKey: "github",
        enabledTools: [],
        syncedTools: [{ name: "get_issue", sensitivity: "read" }],
      }).success,
    ).toBe(false);
    expect(bodySchema.safeParse({ catalogKey: "missing", enabledTools: "all" }).success).toBe(
      false,
    );
  });

  it("enforces explicit allowlists against REST manifests and MCP synced tools", () => {
    expect(
      bodySchema.safeParse({ catalogKey: "github", enabledTools: ["not_a_github_tool"] }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        enabledTools: ["missing_from_sync"],
        syncedTools: [{ name: "search_pages", sensitivity: "read" }],
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({ catalogKey: "notion", enabledTools: ["before_first_sync"] }).success,
    ).toBe(false);
    expect(bodySchema.safeParse({ catalogKey: "notion", enabledTools: [] }).success).toBe(true);
  });
});

describe("resolveInstallationTools", () => {
  it("distinguishes all-tools intent from an explicit list", () => {
    expect(
      resolveInstallationTools(github, { catalogKey: "github", enabledTools: "all" }).map(
        ({ name }) => name,
      ),
    ).toEqual(github.toolManifest.map(({ name }) => name));
    expect(
      resolveInstallationTools(github, {
        catalogKey: "github",
        enabledTools: ["get_issue"],
      }).map(({ name }) => name),
    ).toEqual(["get_issue"]);
  });

  it("applies overrides before synced sensitivity", () => {
    expect(
      resolveInstallationTools(notion, {
        catalogKey: "notion",
        enabledTools: "all",
        syncedTools: [{ name: "delete_page", sensitivity: "destructive" }],
        sensitivityOverrides: { delete_page: "write" },
      }),
    ).toEqual([{ name: "delete_page", sensitivity: "write" }]);
  });

  it("uses destructive as the conservative final fallback", () => {
    const incompleteProvider = {
      ...github,
      toolManifest: [{ ...github.toolManifest[0], sensitivity: undefined }],
    } as unknown as ProviderDef;
    expect(
      resolveInstallationTools(incompleteProvider, {
        catalogKey: "github",
        enabledTools: "all",
      })[0]?.sensitivity,
    ).toBe("destructive");
  });
});
