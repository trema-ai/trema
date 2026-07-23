import { describe, expect, it } from "vitest";

import type { ConnectorInstallationBody } from "#/services/connectors/installations.js";
import {
  mapMcpTool,
  mergeSyncedTools,
  sensitivityFromMcpAnnotations,
} from "#/services/connectors/sync.js";

const connectionId = "00000000-0000-4000-8000-000000000001";

describe("MCP sensitivity classification", () => {
  it.each([
    [{ readOnlyHint: true, destructiveHint: true }, "read"],
    [{ readOnlyHint: false, destructiveHint: false }, "write"],
    [{ readOnlyHint: false, destructiveHint: true }, "destructive"],
    [undefined, "destructive"],
  ] as const)("classifies %j as %s", (annotations, expected) => {
    expect(sensitivityFromMcpAnnotations(annotations)).toBe(expected);
  });

  it("maps name, description, and annotations to the stored shape", () => {
    expect(
      mapMcpTool({
        name: "read_page",
        description: "Read a page",
        annotations: { readOnlyHint: true },
      }),
    ).toEqual({ name: "read_page", description: "Read a page", sensitivity: "read" });
  });
});

const initialTools = [
  { name: "kept", description: "old", sensitivity: "read" as const },
  { name: "removed", sensitivity: "write" as const },
];
const freshTools = [
  { name: "kept", description: "new", sensitivity: "write" as const },
  { name: "added", sensitivity: "destructive" as const },
];

describe("MCP tool drift merge", () => {
  it("keeps all-tools intent so new tools become enabled", () => {
    const merged = mergeSyncedTools(
      { catalogKey: "notion", connectionId, enabledTools: "all", syncedTools: initialTools },
      freshTools,
    );
    expect(merged.body.enabledTools).toBe("all");
    expect(merged.body.syncedTools).toEqual(freshTools);
    expect(merged.report).toEqual({
      added: ["added"],
      removed: ["removed"],
      changed: ["kept"],
    });
  });

  it("prunes removed explicit entries and leaves new tools disabled", () => {
    const merged = mergeSyncedTools(
      {
        catalogKey: "notion",
        connectionId,
        enabledTools: ["kept", "removed"],
        syncedTools: initialTools,
      },
      freshTools,
    );
    expect(merged.body.enabledTools).toEqual(["kept"]);
    expect(merged.body.syncedTools?.map(({ name }) => name)).toEqual(["kept", "added"]);
  });

  it("preserves overrides for removed tools and re-applies them if the tool returns", () => {
    const original: ConnectorInstallationBody = {
      catalogKey: "notion",
      connectionId,
      enabledTools: "all",
      syncedTools: initialTools,
      sensitivityOverrides: { removed: "read" },
    };
    const withoutTool = mergeSyncedTools(original, freshTools).body;
    expect(withoutTool.sensitivityOverrides).toEqual({ removed: "read" });

    const returned = mergeSyncedTools(withoutTool, [
      ...freshTools,
      { name: "removed", sensitivity: "destructive" },
    ]).body;
    expect(returned.sensitivityOverrides).toEqual({ removed: "read" });
  });
});
