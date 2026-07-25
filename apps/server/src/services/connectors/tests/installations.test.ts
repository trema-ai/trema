import type { ProviderDef } from "@trema/connectors";
import { githubProvider, loadProviderCatalog, notionMcpProvider } from "@trema/connectors";
import { describe, expect, it } from "vitest";
import {
  createConnectorInstallationBodySchema,
  resolveInstallationTools,
} from "#server/services/connectors/installations.js";

const catalog = loadProviderCatalog([githubProvider, notionMcpProvider]);
const bodySchema = createConnectorInstallationBodySchema(catalog);
const github = catalog.find(({ key }) => key === "github")!;
const notion = catalog.find(({ key }) => key === "notion")!;
const connectionId = "00000000-0000-4000-8000-000000000001";

describe("connector installation body", () => {
  it("accepts valid REST and pre/post-sync MCP bodies", () => {
    expect(
      bodySchema.safeParse({ catalogKey: "github", connectionId, enabledTools: ["get_issue"] })
        .success,
    ).toBe(true);
    expect(
      bodySchema.safeParse({ catalogKey: "notion", connectionId, enabledTools: "all" }).success,
    ).toBe(true);
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        connectionId,
        enabledTools: ["search_pages"],
        syncedTools: [{ name: "search_pages", sensitivity: "read" }],
      }).success,
    ).toBe(true);
  });

  it("rejects synced tools on REST and unknown catalog keys", () => {
    expect(
      bodySchema.safeParse({
        catalogKey: "github",
        connectionId,
        enabledTools: [],
        syncedTools: [{ name: "get_issue", sensitivity: "read" }],
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({ catalogKey: "missing", connectionId, enabledTools: "all" }).success,
    ).toBe(false);
  });

  it("enforces explicit allowlists against REST manifests and MCP synced tools", () => {
    expect(
      bodySchema.safeParse({
        catalogKey: "github",
        connectionId,
        enabledTools: ["not_a_github_tool"],
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        connectionId,
        enabledTools: ["missing_from_sync"],
        syncedTools: [{ name: "search_pages", sensitivity: "read" }],
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        connectionId,
        enabledTools: ["before_first_sync"],
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({ catalogKey: "notion", connectionId, enabledTools: [] }).success,
    ).toBe(true);
  });

  it("keeps connection config and provider scopes off installations", () => {
    expect(
      bodySchema.safeParse({
        catalogKey: "github",
        connectionId,
        enabledTools: "all",
        providerScopes: ["repo", "read:org"],
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({
        catalogKey: "github",
        connectionId,
        enabledTools: "all",
        config: { tenant: "example" },
      }).success,
    ).toBe(false);
  });
});

describe("resolveInstallationTools", () => {
  it("distinguishes all-tools intent from an explicit list", () => {
    expect(
      resolveInstallationTools(github, {
        catalogKey: "github",
        connectionId,
        enabledTools: "all",
      }).map(({ name }) => name),
    ).toEqual(github.toolManifest.map(({ name }) => name));
    expect(
      resolveInstallationTools(github, {
        catalogKey: "github",
        connectionId,
        enabledTools: ["get_issue"],
      }).map(({ name }) => name),
    ).toEqual(["get_issue"]);
  });

  it("applies overrides before synced sensitivity", () => {
    expect(
      resolveInstallationTools(notion, {
        catalogKey: "notion",
        connectionId,
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
        connectionId,
        enabledTools: "all",
      })[0]?.sensitivity,
    ).toBe("destructive");
  });
});
