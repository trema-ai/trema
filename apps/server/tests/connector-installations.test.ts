import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#/generated/prisma/client.js";
import { createAuth } from "#/lib/auth/index.js";
import { encryptEnvelope } from "#/lib/crypto/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { connectorsRouter } from "#/rpc/connectors.js";
import { itemsRouter } from "#/rpc/items.js";
import { orgRouter } from "#/rpc/org.js";
import type {
  McpClientFactory,
  McpClientFactoryInput,
  McpToolsClient,
} from "#/services/connectors/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 42).toString("base64");

integration("connector installations and MCP sync", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "connector-installations-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_AUTH_BASE_URL: "https://auth.trema.example",
    TREMA_WEB_ORIGINS: "https://app.trema.example",
    TREMA_CREDENTIAL_MASTER_KEY: masterKey,
  });
  const auth = createAuth({ db, env });

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

  async function createOrg() {
    const owner = await signUp("Connector Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Connector Installation Org" },
      { context: owner.context },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    return { ...owner, ...membership, orgScope };
  }

  async function addMember(orgId: string, scopeId: string, role: Role, name = "Connector Member") {
    const member = await signUp(name);
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: member.user.id,
        displayName: name,
        email: member.user.email,
      },
    });
    await db.grant.create({ data: { orgId, principalId: principal.id, scopeId, role } });
    await db.session.updateMany({
      where: { userId: member.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...member, principal };
  }

  it("enforces installation authority and blocks generic connector writes", async () => {
    const org = await createOrg();
    const admin = await addMember(org.org.id, org.orgScope.id, "admin", "Connector Admin");
    const member = await addMember(org.org.id, org.orgScope.id, "member");
    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        name: "Connector Member",
        ownerId: member.principal.id,
      },
    });

    const restInstallation = await call(
      connectorsRouter.installations.create,
      { scopeId: org.orgScope.id, catalogKey: "github", enabledTools: ["get_issue"] },
      { context: admin.context },
    );
    expect(restInstallation).toMatchObject({ status: "active", disclosure: "retrieved" });
    await expect(
      call(
        connectorsRouter.installations.create,
        { scopeId: personal.id, catalogKey: "notion", enabledTools: "all" },
        { context: member.context },
      ),
    ).resolves.toMatchObject({ scopeId: personal.id, body: { catalogKey: "notion" } });
    await expect(
      call(
        connectorsRouter.installations.create,
        { scopeId: personal.id, catalogKey: "linear", enabledTools: [] },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        connectorsRouter.installations.create,
        { scopeId: org.orgScope.id, catalogKey: "github", enabledTools: [] },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        itemsRouter.create,
        {
          scopeId: org.orgScope.id,
          kind: "connector",
          title: "Bypass",
          body: { catalogKey: "github", enabledTools: [] },
        },
        { context: org.context },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("connector installation routes"),
    });
    await expect(
      call(
        connectorsRouter.installations.sync,
        { installationItemId: restInstallation.id },
        { context: admin.context },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("uses REST"),
    });

    const safeCatalog = await call(connectorsRouter.catalog.list, undefined, {
      context: member.context,
    });
    expect(JSON.stringify(safeCatalog)).not.toMatch(/authorizationUrl|tokenUrl|serverUrl/);
  });

  it("syncs through a real MCP pair, applies drift, and selects credentials", async () => {
    const org = await createOrg();
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "agent" },
    });
    const installation = await call(
      connectorsRouter.installations.create,
      {
        scopeId: org.orgScope.id,
        catalogKey: "notion",
        enabledTools: "all",
        sensitivityOverrides: { remove_me: "read" },
      },
      { context: org.context },
    );
    await db.connectorCredential.create({
      data: {
        orgId: org.org.id,
        installationItemId: installation.id,
        principalId: agent.id,
        mode: "mcp_oauth",
        ciphertext: encryptEnvelope({ accessToken: "agent-sync-token" }, masterKey),
      },
    });

    let tools = [
      {
        name: "read_page",
        description: "Read a page",
        annotations: { readOnlyHint: true },
      },
      {
        name: "remove_me",
        description: "Update a page",
        annotations: { destructiveHint: false },
      },
      { name: "unknown_risk", description: "Do something" },
    ];
    const factoryInputs: McpClientFactoryInput[] = [];
    const mcpClientFactory: McpClientFactory = async (input) => {
      factoryInputs.push(input);
      const server = new McpServer({ name: "sync-test", version: "1.0.0" });
      for (const tool of tools) {
        server.registerTool(
          tool.name,
          {
            description: tool.description,
            ...(tool.annotations ? { annotations: tool.annotations } : {}),
          },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
      }
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await server.connect(serverTransport);
      const client = new Client({ name: "sync-test-client", version: "1.0.0" });
      await client.connect(clientTransport);
      return {
        listTools: async (params) => {
          const page = await client.listTools(params);
          return {
            tools: page.tools,
            ...(page.nextCursor ? { nextCursor: page.nextCursor } : {}),
          };
        },
        close: async () => {
          await client.close();
          await server.close();
        },
      } satisfies McpToolsClient;
    };
    const syncContext = { ...org.context, mcpClientFactory };

    const first = await call(
      connectorsRouter.installations.sync,
      { installationItemId: installation.id },
      { context: syncContext },
    );
    expect(first.report).toEqual({
      added: ["read_page", "remove_me", "unknown_risk"],
      removed: [],
      changed: [],
    });
    expect(first.installation.body).toMatchObject({
      syncedTools: [
        { name: "read_page", sensitivity: "read" },
        { name: "remove_me", sensitivity: "write" },
        { name: "unknown_risk", sensitivity: "destructive" },
      ],
      sensitivityOverrides: { remove_me: "read" },
    });
    expect(factoryInputs[0]).toMatchObject({ authorization: "Bearer agent-sync-token" });

    await call(
      connectorsRouter.installations.update,
      { installationItemId: installation.id, enabledTools: ["read_page", "remove_me"] },
      { context: org.context },
    );
    tools = [
      {
        name: "read_page",
        description: "Read a page with details",
        annotations: { destructiveHint: false },
      },
      { name: "new_tool", description: "A new tool", annotations: { readOnlyHint: true } },
    ];
    const second = await call(
      connectorsRouter.installations.sync,
      { installationItemId: installation.id },
      { context: syncContext },
    );
    expect(second.report).toEqual({
      added: ["new_tool"],
      removed: ["remove_me", "unknown_risk"],
      changed: ["read_page"],
    });
    expect(second.installation.body).toMatchObject({
      enabledTools: ["read_page"],
      sensitivityOverrides: { remove_me: "read" },
      syncedTools: [{ name: "read_page" }, { name: "new_tool" }],
    });
    await expect(
      db.auditLog.findFirst({
        where: {
          orgId: org.org.id,
          action: "connector.installation.sync",
          subject: installation.id,
        },
        orderBy: { createdAt: "desc" },
      }),
    ).resolves.toMatchObject({
      actorPrincipalId: org.principal.id,
      payload: second.report,
    });

    const unauthenticated = await call(
      connectorsRouter.installations.create,
      { scopeId: org.orgScope.id, catalogKey: "notion", enabledTools: [] },
      { context: org.context },
    );
    await call(
      connectorsRouter.installations.sync,
      { installationItemId: unauthenticated.id },
      { context: syncContext },
    );
    expect(factoryInputs.at(-1)?.authorization).toBeUndefined();
  });

  it("sends stored credentials through streamable HTTP and otherwise omits authorization", async () => {
    const org = await createOrg();
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "agent" },
    });

    async function httpHarness() {
      const receivedAuthorization: Array<string | null> = [];
      // A stateless streamable-HTTP transport serves exactly one request, so
      // each fetch stands up a fresh server + transport pair.
      const fetch: typeof globalThis.fetch = async (input, init) => {
        const request = new Request(input, init);
        receivedAuthorization.push(request.headers.get("authorization"));
        const server = new McpServer({ name: "http-sync-test", version: "1.0.0" });
        server.registerTool(
          "list_pages",
          { description: "List pages", annotations: { readOnlyHint: true } },
          async () => ({ content: [{ type: "text", text: "ok" }] }),
        );
        const transport = new WebStandardStreamableHTTPServerTransport({
          enableJsonResponse: true,
        });
        await server.connect(transport as Parameters<McpServer["connect"]>[0]);
        return transport.handleRequest(request);
      };
      return { fetch, receivedAuthorization };
    }

    const authenticated = await call(
      connectorsRouter.installations.create,
      { scopeId: org.orgScope.id, catalogKey: "notion", enabledTools: "all" },
      { context: org.context },
    );
    await db.connectorCredential.create({
      data: {
        orgId: org.org.id,
        installationItemId: authenticated.id,
        principalId: agent.id,
        mode: "mcp_oauth",
        ciphertext: encryptEnvelope({ accessToken: "http-sync-token" }, masterKey),
      },
    });
    const authenticatedHarness = await httpHarness();
    await call(
      connectorsRouter.installations.sync,
      { installationItemId: authenticated.id },
      {
        context: { ...org.context, connectorFetch: authenticatedHarness.fetch },
      },
    );
    expect(authenticatedHarness.receivedAuthorization).toContain("Bearer http-sync-token");

    const publicInstallation = await call(
      connectorsRouter.installations.create,
      { scopeId: org.orgScope.id, catalogKey: "notion", enabledTools: "all" },
      { context: org.context },
    );
    const publicHarness = await httpHarness();
    await call(
      connectorsRouter.installations.sync,
      { installationItemId: publicInstallation.id },
      { context: { ...org.context, connectorFetch: publicHarness.fetch } },
    );
    expect(publicHarness.receivedAuthorization.every((value) => value === null)).toBe(true);
  });
});
