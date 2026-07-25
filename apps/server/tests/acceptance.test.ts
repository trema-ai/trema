import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { bindingsRouter } from "#/rpc/bindings.js";
import { serviceCredentialsRouter } from "#/rpc/credentials.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import { createItem } from "#/services/items/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const origin = "http://context.test";

/**
 * The context app's acceptance path, driven the way a harness drives it: the
 * session protocol over plain HTTP, then the data plane over MCP. Each phase
 * adds to this one run — memory writes, the approval round-trip, skills.
 */
integration("acceptance", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "acceptance-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  });
  const auth = createAuth({ db, env });
  const app = createApp({ db, auth, env });

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function signUp(name: string) {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name, email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  it("opens a session, searches the context, saves a memory, and reads it back", async () => {
    // An administrator sets up the organization: a team scope, the Slack
    // channel bound to it, and one memory worth retrieving.
    const owner = await signUp("Acceptance Owner");
    const { org, principal } = await call(
      orgRouter.create,
      { name: "Acceptance Org" },
      { context: owner.context },
    );
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: owner.context },
    );
    const scope = await call(
      scopesRouter.create,
      { name: "Engineering" },
      { context: owner.context },
    );
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T9:C9", scopeId: scope.id },
      { context: owner.context },
    );
    const item = await createItem(db, {
      orgId: org.id,
      actorPrincipalId: principal.id,
      scopeId: scope.id,
      kind: "memory",
      title: "Release train",
      body: {
        type: "fact",
        content: "The release train leaves every Tuesday at 10:00 and freezes on Monday evening.",
      },
    });

    // The harness opens a session for the channel.
    const openResponse = await app.fetch(
      new Request(`${origin}/api/v1/sessions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${credential.secret}`,
        },
        body: JSON.stringify({ surface: "slack", locationRef: "T9:C9" }),
      }),
    );
    expect(openResponse.status).toBe(200);
    const session = (await openResponse.json()) as { sessionId: string; sessionToken: string };
    expect(session.sessionToken).toMatch(/^trema_ses_/);

    // The model reaches the context through the data plane, with the session
    // token as its only credential.
    const client = new Client({ name: "acceptance-harness", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(`${origin}/api/v1/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${session.sessionToken}` } },
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport as Parameters<Client["connect"]>[0]);

    const found = (await client.callTool({
      name: "search_context",
      arguments: { query: "release train" },
    })) as CallToolResult;
    const { results } = found.structuredContent as { results: { id: string }[] };
    expect(results.map(({ id }) => id)).toEqual([item.id]);

    const read = (await client.callTool({
      name: "get_item",
      arguments: { id: results[0]?.id },
    })) as CallToolResult;
    expect(read.structuredContent).toMatchObject({
      id: item.id,
      title: "Release train",
      body: { type: "fact" },
    });

    // The run learns something worth keeping and writes it down. The memory
    // lands at the session's own scope, active, because a fact is cheap to
    // correct.
    const remembered = (await client.callTool({
      name: "save_memory",
      arguments: {
        type: "fact",
        title: "Release captain",
        content: "Priya runs the release train and announces the freeze.",
      },
    })) as CallToolResult;
    expect(remembered.isError).toBeFalsy();
    const memory = remembered.structuredContent as { id: string };
    expect(remembered.structuredContent).toMatchObject({
      scopeId: scope.id,
      status: "active",
      version: 1,
      superseded: null,
    });

    const readBack = (await client.callTool({
      name: "get_item",
      arguments: { id: memory.id },
    })) as CallToolResult;
    expect(readBack.structuredContent).toMatchObject({
      id: memory.id,
      title: "Release captain",
      body: { type: "fact", content: "Priya runs the release train and announces the freeze." },
    });

    await client.close();

    // The run's usage lands on the session, and the whole exchange is in the
    // audit stream.
    const closeResponse = await app.fetch(
      new Request(`${origin}/api/v1/sessions/${session.sessionId}/close`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          authorization: `Bearer ${session.sessionToken}`,
        },
        body: JSON.stringify({ usage: { totalTokens: 900 } }),
      }),
    );
    expect(closeResponse.status).toBe(200);

    const actions = await db.auditLog.findMany({
      where: { orgId: org.id },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(actions.map(({ action }) => action)).toEqual(
      expect.arrayContaining([
        "session.open",
        "dataplane.search_context",
        "dataplane.get_item",
        "dataplane.save_memory",
        "session.close",
      ]),
    );
  });
});
