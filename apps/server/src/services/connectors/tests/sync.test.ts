import { describe, expect, it } from "vitest";

import { mapMcpTool, mergeSyncedTools } from "#server/services/connectors/sync.js";

const connectionId = "00000000-0000-4000-8000-000000000001";

describe("MCP tool mapping", () => {
  it("maps name, description, and annotations to the stored shape verbatim", () => {
    expect(
      mapMcpTool({
        name: "read_page",
        description: "Read a page",
        annotations: { readOnlyHint: true },
      }),
    ).toEqual({
      name: "read_page",
      description: "Read a page",
      annotations: { readOnlyHint: true },
    });
  });

  it("drops absent descriptions and empty annotations instead of storing them", () => {
    expect(mapMcpTool({ name: "bare" })).toEqual({ name: "bare" });
    expect(mapMcpTool({ name: "bare", annotations: {} })).toEqual({ name: "bare" });
  });
});

const initialTools = [{ name: "kept", description: "old" }, { name: "removed" }];
const freshTools = [{ name: "kept", description: "new" }, { name: "added" }];

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

  it("counts an annotations change as drift and stores the fresh annotations verbatim", () => {
    const merged = mergeSyncedTools(
      {
        catalogKey: "notion",
        connectionId,
        enabledTools: "all",
        syncedTools: [{ name: "kept", annotations: { readOnlyHint: true } }],
      },
      [{ name: "kept", annotations: { readOnlyHint: false, destructiveHint: true } }],
    );
    expect(merged.report).toEqual({ added: [], removed: [], changed: ["kept"] });
    expect(merged.body.syncedTools).toEqual([
      { name: "kept", annotations: { readOnlyHint: false, destructiveHint: true } },
    ]);
  });
});
