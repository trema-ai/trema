import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { connectorsRouter } from "#server/rpc/connectors.js";
import { itemsRouter } from "#server/rpc/items.js";
import { orgRouter } from "#server/rpc/org.js";
import {
  createConnectorInstallation,
  type McpClientFactory,
  syncConnectorInstallation,
  updateConnectorInstallation,
} from "#server/services/connectors/index.js";
import {
  archiveConnectorInstallation,
  lockConnectorBindingMutations,
  lockConnectorConnectionBindings,
  provisionConnectorInstallation,
} from "#server/services/connectors/installations.js";
import { archiveItem } from "#server/services/items/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 42).toString("base64");

// Read the shipped migration rather than restating it, so the backfill the test
// proves cannot drift from the one deployments run.
function migrationStatements(name: string): string[] {
  const path = fileURLToPath(
    new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
  );
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

integration("connector connections and installations", () => {
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
  const emptyMcpFactory: McpClientFactory = async () => ({
    listTools: async () => ({ tools: [] }),
    close: async () => {},
  });

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

  async function createOrg(name = "Connector Org") {
    const owner = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: owner.context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "agent" },
    });
    return { ...owner, ...membership, orgScope, agent };
  }

  async function addMember(orgId: string, scopeId: string, role: Role) {
    const member = await signUp("Connector Member");
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: member.user.id,
        displayName: "Connector Member",
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

  async function connection(input: {
    orgId: string;
    principalId: string;
    providerKey: string;
    token?: string;
    revokedAt?: Date;
  }) {
    return db.connectorConnection.create({
      data: {
        orgId: input.orgId,
        providerKey: input.providerKey,
        ownerPrincipalId: input.principalId,
        authMode: input.providerKey === "notion" ? "mcp_oauth" : "oauth2_code",
        config: {},
        ciphertext: encryptEnvelope({ accessToken: input.token ?? "token" }, masterKey),
        ...(input.revokedAt ? { revokedAt: input.revokedAt } : {}),
      },
    });
  }

  it("keeps connector writes capability-guarded and catalog metadata secret-free", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member");
    const agentConnection = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "github",
    });
    await expect(
      call(
        connectorsRouter.installations.create,
        {
          scopeId: org.orgScope.id,
          catalogKey: "github",
          connectionId: agentConnection.id,
          enabledTools: [],
        },
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
          body: {
            catalogKey: "github",
            connectionId: agentConnection.id,
            enabledTools: [],
          },
        },
        { context: org.context },
      ),
    ).rejects.toMatchObject({
      code: "BAD_REQUEST",
      message: expect.stringContaining("connector installation routes"),
    });

    const catalog = await call(connectorsRouter.catalog.list, undefined, {
      context: member.context,
    });
    expect(JSON.stringify(catalog)).not.toMatch(
      /authorizationUrl|tokenUrl|serverUrl|clientSecret|ciphertext/,
    );
    expect(catalog.find(({ key }) => key === "notion")).toMatchObject({
      supportsPersonalOAuth: true,
      transport: { type: "mcp" },
    });
    await expect(call(connectorsRouter.meta, undefined, { context: org.context })).resolves.toEqual(
      {
        callbackUrl: "https://auth.trema.example/connect/callback",
      },
    );
  });

  it("validates connection org, provider, revocation, and agent ownership on create and update", async () => {
    const org = await createOrg();
    const other = await createOrg("Other Org");
    const human = await addMember(org.org.id, org.orgScope.id, "admin");
    const agentGithub = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "github",
    });
    const humanGithub = await connection({
      orgId: org.org.id,
      principalId: human.principal.id,
      providerKey: "github",
    });
    const agentStripe = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "stripe",
    });
    const revokedGithub = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "github",
      revokedAt: new Date(),
    });
    const otherGithub = await connection({
      orgId: other.org.id,
      principalId: other.agent.id,
      providerKey: "github",
    });

    const installation = await call(
      connectorsRouter.installations.create,
      {
        scopeId: org.orgScope.id,
        catalogKey: "github",
        connectionId: agentGithub.id,
      },
      { context: org.context },
    );
    for (const invalidConnectionId of [
      humanGithub.id,
      agentStripe.id,
      revokedGithub.id,
      otherGithub.id,
    ]) {
      await expect(
        call(
          connectorsRouter.installations.create,
          {
            scopeId: org.orgScope.id,
            catalogKey: "github",
            connectionId: invalidConnectionId,
          },
          { context: org.context },
        ),
      ).rejects.toThrow();
      await expect(
        call(
          connectorsRouter.installations.update,
          {
            installationItemId: installation.id,
            connectionId: invalidConnectionId,
          },
          { context: org.context },
        ),
      ).rejects.toThrow();
    }
    const secondGithub = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "github",
    });
    await expect(
      call(
        connectorsRouter.installations.update,
        { installationItemId: installation.id, connectionId: secondGithub.id },
        { context: org.context },
      ),
    ).resolves.toMatchObject({
      body: { catalogKey: "github", connectionId: secondGithub.id },
    });
  });

  it("allows user OAuth and rejects app or static credentials in personal scopes", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member");
    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        name: "Connector Member",
        ownerId: member.principal.id,
      },
    });
    const memberNotion = await connection({
      orgId: org.org.id,
      principalId: member.principal.id,
      providerKey: "notion",
    });
    const memberHubspot = await connection({
      orgId: org.org.id,
      principalId: member.principal.id,
      providerKey: "hubspot",
    });
    const memberSlack = await connection({
      orgId: org.org.id,
      principalId: member.principal.id,
      providerKey: "slack",
    });
    const memberStripe = await connection({
      orgId: org.org.id,
      principalId: member.principal.id,
      providerKey: "stripe",
    });

    await expect(
      createConnectorInstallation(db, {
        orgId: org.org.id,
        actorPrincipalId: member.principal.id,
        scopeId: personal.id,
        catalogKey: "hubspot",
        connectionId: memberHubspot.id,
      }),
    ).resolves.toMatchObject({
      scopeId: personal.id,
      body: { connectionId: memberHubspot.id },
    });

    await expect(
      createConnectorInstallation(db, {
        orgId: org.org.id,
        actorPrincipalId: member.principal.id,
        scopeId: personal.id,
        catalogKey: "notion",
        connectionId: memberNotion.id,
        clientFactory: emptyMcpFactory,
        masterKey,
      }),
    ).resolves.toMatchObject({
      scopeId: personal.id,
      body: { connectionId: memberNotion.id },
    });

    for (const [catalogKey, connectionId] of [
      ["slack", memberSlack.id],
      ["stripe", memberStripe.id],
    ] as const) {
      await expect(
        createConnectorInstallation(db, {
          orgId: org.org.id,
          actorPrincipalId: member.principal.id,
          scopeId: personal.id,
          catalogKey,
          connectionId,
        }),
      ).rejects.toThrow("Personal installations require a user-acting OAuth provider");
    }

    const agentNotion = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
    });
    await expect(
      createConnectorInstallation(db, {
        orgId: org.org.id,
        actorPrincipalId: member.principal.id,
        scopeId: personal.id,
        catalogKey: "notion",
        connectionId: agentNotion.id,
        clientFactory: emptyMcpFactory,
        masterKey,
      }),
    ).rejects.toThrow();
  });

  it("retains personal installation creation for valid unbound connections", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member");
    const other = await addMember(org.org.id, org.orgScope.id, "member");
    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        name: "Connector Member",
        ownerId: member.principal.id,
      },
    });
    const memberGithub = await connection({
      orgId: org.org.id,
      principalId: member.principal.id,
      providerKey: "github",
    });
    const otherGithub = await connection({
      orgId: org.org.id,
      principalId: other.principal.id,
      providerKey: "github",
    });
    expect(connectorsRouter.member.installations).toHaveProperty("create");
    await expect(
      call(
        connectorsRouter.installations.create,
        {
          scopeId: personal.id,
          catalogKey: "github",
          connectionId: memberGithub.id,
        },
        { context: member.context },
      ),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: expect.stringContaining("organization or shared scope"),
    });

    await expect(
      createConnectorInstallation(db, {
        orgId: org.org.id,
        actorPrincipalId: member.principal.id,
        scopeId: personal.id,
        catalogKey: "github",
        connectionId: otherGithub.id,
      }),
    ).rejects.toThrow("scope owner's connection");

    await expect(
      call(
        connectorsRouter.member.installations.create,
        {
          scopeId: personal.id,
          catalogKey: "github",
          connectionId: memberGithub.id,
        },
        { context: member.context },
      ),
    ).resolves.toMatchObject({
      scopeId: personal.id,
      body: {
        catalogKey: "github",
        connectionId: memberGithub.id,
        enabledTools: "all",
      },
    });
  });

  it("archives only the binding and lists safe connection-to-scope metadata", async () => {
    const org = await createOrg();
    const connected = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "github",
      token: "must-not-leak",
    });
    const installation = await call(
      connectorsRouter.installations.create,
      {
        scopeId: org.orgScope.id,
        catalogKey: "github",
        connectionId: connected.id,
      },
      { context: org.context },
    );
    const listed = await call(
      connectorsRouter.connections.list,
      { providerKey: "github" },
      { context: org.context },
    );
    expect(listed).toEqual([
      expect.objectContaining({
        id: connected.id,
        providerKey: "github",
        isValid: true,
        installations: [{ id: installation.id, scopeId: org.orgScope.id }],
      }),
    ]);
    expect(JSON.stringify(listed)).not.toMatch(/ciphertext|must-not-leak|config/);

    await call(
      connectorsRouter.installations.archive,
      { installationItemId: installation.id },
      { context: org.context },
    );
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: connected.id } }),
    ).resolves.toMatchObject({ revokedAt: null });
    await expect(
      call(connectorsRouter.connections.list, { providerKey: "github" }, { context: org.context }),
    ).resolves.toEqual([expect.objectContaining({ id: connected.id, installations: [] })]);
  });

  it("syncs from exactly the bound connection and preserves no-fallback semantics", async () => {
    const org = await createOrg();
    const bound = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
      token: "bound-token",
    });
    await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
      token: "broader-token",
    });
    const calls: Array<string | undefined> = [];
    const factory: McpClientFactory = async (input) => {
      calls.push(input.authorization);
      return {
        listTools: async () => ({
          tools: [
            {
              name: "read_page",
              description: "Read a page",
              annotations: { readOnlyHint: true },
            },
          ],
        }),
        close: async () => {},
      };
    };
    const installation = await call(
      connectorsRouter.installations.create,
      {
        scopeId: org.orgScope.id,
        catalogKey: "notion",
        connectionId: bound.id,
      },
      { context: { ...org.context, mcpClientFactory: factory } },
    );
    expect(calls).toEqual(["Bearer bound-token"]);
    const listed = await call(connectorsRouter.installations.list, {}, { context: org.context });
    expect(listed[0]).toMatchObject({
      id: installation.id,
      connectionId: bound.id,
      syncedTools: [{ name: "read_page", annotations: { readOnlyHint: true } }],
    });

    await db.connectorConnection.update({
      where: { id: bound.id },
      data: { revokedAt: new Date() },
    });
    await expect(
      call(
        connectorsRouter.installations.sync,
        { installationItemId: installation.id },
        { context: { ...org.context, mcpClientFactory: factory } },
      ),
    ).rejects.toMatchObject({
      code: "PRECONDITION_FAILED",
      data: {
        code: "reconnect_needed",
        reconnectNeeded: true,
        connectionId: bound.id,
        providerKey: "notion",
        reason: "revoked",
      },
    });
    expect(calls).toEqual(["Bearer bound-token"]);
  });

  it("clears stale MCP tools while a switched connection awaits a successful sync", async () => {
    const org = await createOrg();
    const first = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
    });
    const second = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
    });
    const workingFactory: McpClientFactory = async () => ({
      listTools: async () => ({
        tools: [{ name: "read_page", annotations: { readOnlyHint: true } }],
      }),
      close: async () => {},
    });
    const installation = await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: org.orgScope.id,
      catalogKey: "notion",
      connectionId: first.id,
      enabledTools: "all",
      clientFactory: workingFactory,
      masterKey,
    });
    await db.item.update({
      where: { orgId_id: { orgId: org.org.id, id: installation.id } },
      data: {
        body: {
          catalogKey: "notion",
          connectionId: first.id,
          enabledTools: ["read_page"],
          syncedTools: [{ name: "read_page", annotations: { readOnlyHint: true } }],
        },
      },
    });
    const failingFactory = vi.fn(async () => {
      throw new Error("MCP unavailable");
    }) satisfies McpClientFactory;

    await updateConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      installationItemId: installation.id,
      connectionId: second.id,
      clientFactory: failingFactory,
      masterKey,
    });
    expect(failingFactory).toHaveBeenCalledOnce();

    const switched = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: installation.id } },
    });
    expect(switched.body).toEqual({
      catalogKey: "notion",
      connectionId: second.id,
      enabledTools: ["read_page"],
      syncPending: true,
    });

    const shared = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Shared MCP connection" },
    });
    const sibling = await createConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: shared.id,
      catalogKey: "notion",
      connectionId: second.id,
      enabledTools: "all",
      clientFactory: workingFactory,
      masterKey,
    });
    await db.item.update({
      where: { orgId_id: { orgId: org.org.id, id: installation.id } },
      data: {
        body: {
          catalogKey: "notion",
          connectionId: second.id,
          enabledTools: ["read_page"],
          syncedTools: [{ name: "read_page", annotations: { readOnlyHint: true } }],
        },
      },
    });
    await db.$transaction((transaction) =>
      provisionConnectorInstallation(transaction, {
        orgId: org.org.id,
        actorPrincipalId: org.principal.id,
        scopeId: org.orgScope.id,
        catalogKey: "notion",
        connectionId: second.id,
        connectionCredentialsChanged: true,
      }),
    );
    await expect(
      db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: installation.id } },
      }),
    ).resolves.toMatchObject({
      body: {
        catalogKey: "notion",
        connectionId: second.id,
        enabledTools: ["read_page"],
        syncPending: true,
      },
    });
    expect(
      (
        await db.item.findUniqueOrThrow({
          where: { orgId_id: { orgId: org.org.id, id: installation.id } },
        })
      ).body,
    ).not.toHaveProperty("syncedTools");
    const invalidatedSibling = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: sibling.id } },
    });
    expect(invalidatedSibling.body).toMatchObject({
      catalogKey: "notion",
      connectionId: second.id,
      enabledTools: "all",
      syncPending: true,
    });
    expect(invalidatedSibling.body).not.toHaveProperty("syncedTools");
  });

  it.each(["provision", "update"] as const)(
    "keeps a concurrent reconnect from restoring the source connection during %s",
    async (operation) => {
      const org = await createOrg();
      const first = await connection({
        orgId: org.org.id,
        principalId: org.agent.id,
        providerKey: "notion",
      });
      const second = await connection({
        orgId: org.org.id,
        principalId: org.agent.id,
        providerKey: "notion",
      });
      const installation = await db.item.create({
        data: {
          orgId: org.org.id,
          scopeId: org.orgScope.id,
          kind: "connector",
          title: "Notion",
          body: {
            catalogKey: "notion",
            connectionId: first.id,
            enabledTools: "all",
            syncedTools: [{ name: "old_tool" }],
          },
          status: "active",
          disclosure: "retrieved",
          createdById: org.principal.id,
          updatedById: org.principal.id,
        },
      });
      let markReconnectRead!: () => void;
      const reconnectRead = new Promise<void>((resolve) => {
        markReconnectRead = resolve;
      });
      let releaseReconnect!: () => void;
      const reconnectRelease = new Promise<void>((resolve) => {
        releaseReconnect = resolve;
      });
      const reconnect = db.$transaction(async (transaction) => {
        await lockConnectorBindingMutations(transaction, org.org.id);
        await lockConnectorConnectionBindings(transaction, org.org.id, first.id);
        const stale = await transaction.item.findUniqueOrThrow({
          where: { orgId_id: { orgId: org.org.id, id: installation.id } },
        });
        markReconnectRead();
        await reconnectRelease;
        const { syncedTools: _syncedTools, ...staleBody } = stale.body as Record<string, unknown>;
        await transaction.item.update({
          where: { orgId_id: { orgId: org.org.id, id: installation.id } },
          data: { body: { ...staleBody, syncPending: true } },
        });
      });
      await reconnectRead;

      const repoint =
        operation === "provision"
          ? db.$transaction((transaction) =>
              provisionConnectorInstallation(transaction, {
                orgId: org.org.id,
                actorPrincipalId: org.principal.id,
                scopeId: org.orgScope.id,
                catalogKey: "notion",
                connectionId: second.id,
              }),
            )
          : updateConnectorInstallation(db, {
              orgId: org.org.id,
              actorPrincipalId: org.principal.id,
              installationItemId: installation.id,
              connectionId: second.id,
              clientFactory: emptyMcpFactory,
              masterKey,
            });
      const stateBeforeReconnectCommit = await Promise.race([
        repoint.then(() => "settled" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
      expect(stateBeforeReconnectCommit).toBe("blocked");

      releaseReconnect();
      await reconnect;
      await repoint;
      await expect(
        db.item.findUniqueOrThrow({
          where: { orgId_id: { orgId: org.org.id, id: installation.id } },
        }),
      ).resolves.toMatchObject({
        body: {
          catalogKey: "notion",
          connectionId: second.id,
          enabledTools: "all",
        },
      });
    },
  );

  it.each(["connector", "generic"] as const)(
    "serializes the %s archive path with connector provisioning",
    async (archivePath) => {
      const org = await createOrg();
      const connected = await connection({
        orgId: org.org.id,
        principalId: org.agent.id,
        providerKey: "github",
      });
      const installation = await createConnectorInstallation(db, {
        orgId: org.org.id,
        actorPrincipalId: org.principal.id,
        scopeId: org.orgScope.id,
        catalogKey: "github",
        connectionId: connected.id,
      });
      let markProvisioningRead!: () => void;
      const provisioningRead = new Promise<void>((resolve) => {
        markProvisioningRead = resolve;
      });
      let releaseProvisioning!: () => void;
      const provisioningRelease = new Promise<void>((resolve) => {
        releaseProvisioning = resolve;
      });
      const provisioning = db.$transaction(async (transaction) => {
        await lockConnectorBindingMutations(transaction, org.org.id);
        await transaction.item.findUniqueOrThrow({
          where: { orgId_id: { orgId: org.org.id, id: installation.id } },
        });
        markProvisioningRead();
        await provisioningRelease;
        return provisionConnectorInstallation(transaction, {
          orgId: org.org.id,
          actorPrincipalId: org.principal.id,
          scopeId: org.orgScope.id,
          catalogKey: "github",
          connectionId: connected.id,
        });
      });
      await provisioningRead;

      const archive =
        archivePath === "connector"
          ? archiveConnectorInstallation(db, {
              orgId: org.org.id,
              actorPrincipalId: org.principal.id,
              installationItemId: installation.id,
            })
          : archiveItem(db, {
              orgId: org.org.id,
              actorPrincipalId: org.principal.id,
              itemId: installation.id,
            });
      const stateBeforeProvisioningCommit = await Promise.race([
        archive.then(() => "settled" as const),
        new Promise<"blocked">((resolve) => setTimeout(() => resolve("blocked"), 50)),
      ]);
      expect(stateBeforeProvisioningCommit).toBe("blocked");

      releaseProvisioning();
      await provisioning;
      await archive;
      await expect(
        db.item.count({
          where: {
            orgId: org.org.id,
            scopeId: org.orgScope.id,
            kind: "connector",
            status: "active",
          },
        }),
      ).resolves.toBe(0);
    },
  );

  it("rejects a delayed MCP sync result when the bound connection changed", async () => {
    const org = await createOrg();
    const first = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
    });
    const second = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
    });
    const installation = await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: org.orgScope.id,
        kind: "connector",
        title: "Notion",
        body: {
          catalogKey: "notion",
          connectionId: first.id,
          enabledTools: "all",
          syncedTools: [{ name: "old_tool" }],
        },
        status: "active",
        disclosure: "retrieved",
        createdById: org.principal.id,
        updatedById: org.principal.id,
      },
    });
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery!: (value: {
      tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    }) => void;
    const discovery = new Promise<{
      tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const delayedFactory: McpClientFactory = async () => ({
      listTools: async () => {
        markDiscoveryStarted();
        return discovery;
      },
      close: async () => {},
    });

    const pendingSync = syncConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      installationItemId: installation.id,
      clientFactory: delayedFactory,
      masterKey,
    });
    await discoveryStarted;
    await db.item.update({
      where: { orgId_id: { orgId: org.org.id, id: installation.id } },
      data: {
        body: {
          catalogKey: "notion",
          connectionId: second.id,
          enabledTools: "all",
          syncPending: true,
        },
      },
    });
    releaseDiscovery({
      tools: [{ name: "old_connection_tool", annotations: { readOnlyHint: true } }],
    });

    await expect(pendingSync).rejects.toThrow("connection changed during tool sync");
    await expect(
      db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: installation.id } },
      }),
    ).resolves.toMatchObject({
      body: {
        catalogKey: "notion",
        connectionId: second.id,
        enabledTools: "all",
        syncPending: true,
      },
    });
  });

  it("rejects a delayed MCP sync result after an in-place connection reconnect", async () => {
    const org = await createOrg();
    const connected = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
      token: "old_account_token",
    });
    const installation = await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: org.orgScope.id,
        kind: "connector",
        title: "Notion",
        body: {
          catalogKey: "notion",
          connectionId: connected.id,
          enabledTools: "all",
          syncedTools: [{ name: "old_tool" }],
        },
        status: "active",
        disclosure: "retrieved",
        createdById: org.principal.id,
        updatedById: org.principal.id,
      },
    });
    let markDiscoveryStarted!: () => void;
    const discoveryStarted = new Promise<void>((resolve) => {
      markDiscoveryStarted = resolve;
    });
    let releaseDiscovery!: (value: {
      tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    }) => void;
    const discovery = new Promise<{
      tools: Array<{ name: string; annotations: { readOnlyHint: boolean } }>;
    }>((resolve) => {
      releaseDiscovery = resolve;
    });
    const delayedFactory: McpClientFactory = async () => ({
      listTools: async () => {
        markDiscoveryStarted();
        return discovery;
      },
      close: async () => {},
    });

    const pendingSync = syncConnectorInstallation(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      installationItemId: installation.id,
      clientFactory: delayedFactory,
      masterKey,
    });
    await discoveryStarted;
    await db.$transaction([
      db.connectorConnection.update({
        where: { id: connected.id },
        data: {
          ciphertext: encryptEnvelope({ accessToken: "new_account_token" }, masterKey),
        },
      }),
      db.item.update({
        where: { orgId_id: { orgId: org.org.id, id: installation.id } },
        data: {
          body: {
            catalogKey: "notion",
            connectionId: connected.id,
            enabledTools: "all",
            syncedTools: [{ name: "new_account_tool" }],
          },
        },
      }),
    ]);
    releaseDiscovery({
      tools: [{ name: "old_account_tool", annotations: { readOnlyHint: true } }],
    });

    await expect(pendingSync).rejects.toThrow("credentials changed during tool sync");
    await expect(
      db.item.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: installation.id } },
      }),
    ).resolves.toMatchObject({
      body: {
        catalogKey: "notion",
        connectionId: connected.id,
        enabledTools: "all",
        syncedTools: [{ name: "new_account_tool" }],
      },
    });
  });

  it("reads installations written before approval modes dropped sensitivity", async () => {
    const org = await createOrg();
    const bound = await connection({
      orgId: org.org.id,
      principalId: org.agent.id,
      providerKey: "notion",
    });
    const legacy = await db.item.create({
      data: {
        orgId: org.org.id,
        scopeId: org.orgScope.id,
        kind: "connector",
        title: "Notion",
        body: {
          catalogKey: "notion",
          connectionId: bound.id,
          enabledTools: ["read_page"],
          sensitivityOverrides: { read_page: "low" },
          syncedTools: [
            {
              name: "read_page",
              description: "Read a page",
              annotations: { readOnlyHint: true },
              sensitivity: "low",
              declaredSensitivity: "medium",
            },
            { name: "write_page", sensitivity: "high" },
          ],
        },
        status: "active",
        disclosure: "retrieved",
        createdById: org.agent.id,
        updatedById: org.agent.id,
      },
    });
    // The strict body schema rejects the legacy shape until the backfill runs.
    await expect(
      call(connectorsRouter.installations.list, {}, { context: org.context }),
    ).rejects.toThrow();

    for (const statement of migrationStatements("20260728190000_connector_body_cleanup")) {
      await db.$executeRawUnsafe(statement);
    }

    await expect(
      call(connectorsRouter.installations.list, {}, { context: org.context }),
    ).resolves.toEqual([
      {
        id: legacy.id,
        scopeId: org.orgScope.id,
        catalogKey: "notion",
        connectionId: bound.id,
        enabledTools: ["read_page"],
        syncedTools: [
          {
            name: "read_page",
            description: "Read a page",
            annotations: { readOnlyHint: true },
          },
          { name: "write_page" },
        ],
        status: "active",
        updatedAt: expect.anything(),
      },
    ]);
  });
});
