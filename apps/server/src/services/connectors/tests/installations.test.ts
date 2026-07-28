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
        syncedTools: [{ name: "search_pages", annotations: { readOnlyHint: true } }],
      }).success,
    ).toBe(true);
  });

  it("rejects synced tools on REST and unknown catalog keys", () => {
    expect(
      bodySchema.safeParse({
        catalogKey: "github",
        connectionId,
        enabledTools: [],
        syncedTools: [{ name: "get_issue" }],
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
        syncedTools: [{ name: "search_pages" }],
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

  it("keeps connection config, provider scopes, and sensitivity overrides off installations", () => {
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
    // Per-tool sensitivity classes are gone: every call goes through the
    // approval gate, so an installation carries no override map.
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        connectionId,
        enabledTools: "all",
        syncedTools: [{ name: "delete_page" }],
        sensitivityOverrides: { delete_page: "read" },
      }).success,
    ).toBe(false);
    expect(
      bodySchema.safeParse({
        catalogKey: "notion",
        connectionId,
        enabledTools: "all",
        syncedTools: [{ name: "delete_page", sensitivity: "destructive" }],
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

  it("carries REST manifest descriptions onto the resolved tools", () => {
    const manifestTool = github.toolManifest.find(({ name }) => name === "get_issue")!;
    expect(
      resolveInstallationTools(github, {
        catalogKey: "github",
        connectionId,
        enabledTools: ["get_issue"],
      }),
    ).toEqual([{ name: "get_issue", description: manifestTool.description }]);
  });

  it("keeps synced descriptions and annotations verbatim as classifier signal", () => {
    expect(
      resolveInstallationTools(notion, {
        catalogKey: "notion",
        connectionId,
        enabledTools: "all",
        syncedTools: [
          {
            name: "delete_page",
            description: "Delete a page",
            annotations: { destructiveHint: true },
          },
        ],
      }),
    ).toEqual([
      {
        name: "delete_page",
        description: "Delete a page",
        annotations: { destructiveHint: true },
      },
    ]);
  });
});
