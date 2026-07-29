import type { ModelPort, RunRecord } from "@trema/harness";
import { describe, expect, it } from "vitest";

import type { Database } from "#server/lib/db/index.js";
import { connectorModelToolName } from "#server/services/dataplane/tools.js";
import { createSessionRunPlan } from "#server/services/runs/plan.js";

const now = new Date("2026-07-19T12:00:00.000Z");
const connectorToolName = connectorModelToolName("github:create_issue");

function run(): RunRecord {
  return {
    id: "run-1",
    threadRef: "thread-1",
    state: "queued",
    trigger: "api",
    sessionId: "session-1",
    createdAt: now.toISOString(),
    updatedAt: now.toISOString(),
  } as unknown as RunRecord;
}

/**
 * The three queries the plan makes, faked: the run row with its allowlist, the
 * pinned session, and the thread's prior runs (none).
 */
function fakeDb(toolAllowlist: string[]): Database {
  return {
    agentRun: {
      findUnique: async () => ({ toolAllowlist, createdAt: now }),
      findMany: async () => [],
    },
    contextSession: {
      findFirst: async () => ({
        id: "session-1",
        orgId: "org-1",
        scopeId: "scope-1",
        scopeChain: ["scope-1"],
        actingPrincipalId: "agent-1",
        requesterPrincipalId: "person-1",
        requesterExternalRef: null,
        approvalMode: "ask",
        policySnapshot: { rows: [] },
        scope: { kind: "org" },
        closedAt: null,
        expiresAt: new Date(now.getTime() + 60_000),
        standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
      }),
    },
    item: {
      findMany: async () => [
        {
          id: "installation-1",
          scopeId: "scope-1",
          body: {
            catalogKey: "github",
            connectionId: "00000000-0000-4000-8000-000000000001",
            enabledTools: "all",
          },
        },
      ],
    },
  } as unknown as Database;
}

function plan(toolAllowlist: string[]) {
  return createSessionRunPlan({
    db: fakeDb(toolAllowlist),
    orgId: "org-1",
    resolveModel: async () => ({
      model: { id: "test/model" },
      modelPort: {} as ModelPort,
    }),
    now: () => now,
  })(run());
}

describe("session run plan tools", () => {
  it("starts with the small built-in surface and no connector schemas", async () => {
    const planned = await plan([]);

    expect(planned.tools.map(({ name }) => name)).toEqual([
      "search_context",
      "get_item",
      "save_memory",
      "update_memory",
      "fetch_transcript",
      "search_tools",
    ]);
    expect(planned.activeToolKeys).toEqual([]);
  });

  it("exposes a deliberately allowlisted connector without discovery", async () => {
    const planned = await plan([connectorToolName]);

    expect(planned.tools).toEqual([]);
    expect(planned.activeToolKeys).toEqual(["github:create_issue"]);
  });

  it("keeps use_connector off the in-process model surface", async () => {
    const planned = await plan(["use_connector"]);

    expect(planned.tools).toEqual([]);
    expect(planned.activeToolKeys).toEqual([]);
  });

  it("lets the allowlist narrow it away, and never widen", async () => {
    const planned = await plan(["some_other_tool"]);

    // The allowlist names a tool the session did not resolve: nothing widens,
    // and the named-but-unresolved tool never appears.
    expect(planned.tools).toEqual([]);
  });
});
