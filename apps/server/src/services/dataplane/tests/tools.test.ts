import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";
import {
  capabilityToolDefs,
  connectorModelToolName,
  resolveConnectorToolDefs,
  sessionToolDefs,
} from "#server/services/dataplane/tools.js";

const session: DataPlaneSession = {
  id: "session-1",
  orgId: "org-1",
  scopeId: "scope-1",
  scopeKind: "org",
  scopeChain: ["scope-1"],
  agentPrincipalId: "agent-1",
  requesterPrincipalId: "person-1",
  requesterExternalRef: null,
  approvalMode: "ask",
  policyRows: [],
};

describe("data-plane tool registry", () => {
  it("publishes every built-in through one model-facing registry", () => {
    expect(sessionToolDefs().map(({ name }) => name)).toEqual([
      "search_context",
      "get_item",
      "save_memory",
      "update_memory",
      "fetch_transcript",
      "search_tools",
      "use_connector",
    ]);
  });

  it("publishes only the native capabilities whose routes are enabled", () => {
    expect(capabilityToolDefs(["web.search"]).map(({ name }) => name)).toEqual(["search_web"]);
    expect(capabilityToolDefs(["web.fetch"]).map(({ name }) => name)).toEqual(["fetch_url"]);
    expect(capabilityToolDefs(["web.search", "web.fetch"]).map(({ name }) => name)).toEqual([
      "search_web",
      "fetch_url",
    ]);
  });

  it("normalizes connector function names while retaining a bounded stable name", () => {
    const name = connectorModelToolName(
      "notion:search-for-pages/with a provider name that is far too long for a model tool",
    );
    expect(name).toMatch(/^[A-Za-z_][A-Za-z0-9_]*$/);
    expect(name.length).toBeLessThanOrEqual(64);
    expect(name).toBe(
      connectorModelToolName(
        "notion:search-for-pages/with a provider name that is far too long for a model tool",
      ),
    );
  });

  it("turns synced MCP operations into first-class typed connector tools", async () => {
    const db = {
      item: {
        findMany: async () => [
          {
            id: "installation-1",
            scopeId: "scope-1",
            body: {
              catalogKey: "notion",
              connectionId: "00000000-0000-4000-8000-000000000001",
              enabledTools: "all",
              syncedTools: [
                {
                  name: "search_pages",
                  description: "Search workspace pages",
                  inputSchema: {
                    type: "object",
                    properties: { query: { type: "string" } },
                    required: ["query"],
                  },
                  annotations: { readOnlyHint: true },
                },
              ],
            },
          },
        ],
      },
    } as unknown as Database;

    const tools = await resolveConnectorToolDefs(db, session);

    expect(tools).toHaveLength(1);
    expect(tools[0]).toMatchObject({
      key: "notion:search_pages",
      kind: "connector",
      connector: {
        key: "notion",
        displayName: "Notion",
        logoUrl: "/connector-logos/notion.svg",
      },
      description: "Search workspace pages",
      schema: {
        type: "object",
        properties: { query: { type: "string" } },
        required: ["query"],
      },
    });
  });
});
