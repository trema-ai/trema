import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createPrismaClient } from "#server/lib/db/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const conflictPreflight = "20260730175000_connector_identity_conflict_preflight";
const clientRegistrationMigration = "20260802154500_connector_client_registration";

function migrationSource(name: string): string {
  const path = fileURLToPath(
    new URL(`../prisma/migrations/${name}/migration.sql`, import.meta.url),
  );
  return readFileSync(path, "utf8");
}

function migrationBlock(name: string, marker: string): string {
  const source = migrationSource(name);
  const start = `-- BEGIN ${marker}`;
  const end = `-- END ${marker}`;
  const startAt = source.indexOf(start);
  const endAt = source.indexOf(end);
  if (startAt < 0 || endAt < 0 || endAt <= startAt) {
    throw new Error(`Migration block not found: ${name}/${marker}`);
  }
  return source.slice(startAt + start.length, endAt).trim();
}

integration("connector identity migrations", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function fixture() {
    const org = await db.org.create({ data: { name: "Migration fixture" } });
    const agent = await db.principal.create({
      data: { orgId: org.id, kind: "agent", displayName: "Trema" },
    });
    const human = await db.principal.create({
      data: { orgId: org.id, kind: "human", displayName: "Human" },
    });
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    const personalScope = await db.scope.create({
      data: {
        orgId: org.id,
        kind: "personal",
        name: "Personal",
        ownerId: human.id,
      },
    });
    const agentConnection = await db.connectorConnection.create({
      data: {
        orgId: org.id,
        providerKey: "slack",
        ownerPrincipalId: agent.id,
        authMode: "oauth2_code",
        config: {},
        ciphertext: "migration-fixture-agent",
      },
    });
    const humanConnection = await db.connectorConnection.create({
      data: {
        orgId: org.id,
        providerKey: "github",
        ownerPrincipalId: human.id,
        authMode: "oauth2_code",
        config: {},
        ciphertext: "migration-fixture-human",
      },
    });
    return { org, agent, human, orgScope, personalScope, agentConnection, humanConnection };
  }

  it("runs a read-only conflict preflight before state-changing uniqueness migrations", () => {
    const source = migrationSource(conflictPreflight);
    const sqlWithoutComments = source.replace(/^\s*--.*$/gm, "");

    expect(conflictPreflight < "20260730180000_atomic_connector_provisioning").toBe(true);
    expect(sqlWithoutComments).not.toMatch(
      /\b(?:INSERT|UPDATE|DELETE|ALTER|CREATE|DROP|TRUNCATE)\b/i,
    );
    expect(source).toContain(
      "prisma migrate resolve --rolled-back 20260730175000_connector_identity_conflict_preflight",
    );
  });

  it("backfills active installation access without changing scope or credential ownership", async () => {
    const setup = await fixture();
    const personal = await db.item.create({
      data: {
        orgId: setup.org.id,
        scopeId: setup.personalScope.id,
        kind: "connector",
        title: "GitHub",
        body: {
          catalogKey: "github",
          connectionId: setup.humanConnection.id,
          enabledTools: "all",
        },
        status: "active",
        disclosure: "retrieved",
        createdById: setup.human.id,
      },
    });
    const organization = await db.item.create({
      data: {
        orgId: setup.org.id,
        scopeId: setup.orgScope.id,
        kind: "connector",
        title: "Slack",
        body: {
          catalogKey: "slack",
          connectionId: setup.agentConnection.id,
          enabledTools: "all",
        },
        status: "active",
        disclosure: "retrieved",
        createdById: setup.agent.id,
      },
    });
    await db.$executeRawUnsafe(migrationSource("20260730190000_connector_installation_access"));

    await expect(
      db.item.findMany({
        where: { id: { in: [personal.id, organization.id] } },
        orderBy: { id: "asc" },
        select: { scopeId: true, body: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          scopeId: setup.personalScope.id,
          body: expect.objectContaining({
            connectionId: setup.humanConnection.id,
            access: { kind: "scope" },
          }),
        },
        {
          scopeId: setup.orgScope.id,
          body: expect.objectContaining({
            connectionId: setup.agentConnection.id,
            access: { kind: "scope" },
          }),
        },
      ]),
    );
  });

  it("backfills unambiguous OAuth registrations across providers and revokes ambiguity", async () => {
    const setup = await fixture();
    const [githubRegistration, linearRegistration] = await Promise.all([
      db.clientRegistration.create({
        data: { orgId: setup.org.id, providerKey: "github", source: "customer" },
      }),
      db.clientRegistration.create({
        data: { orgId: setup.org.id, providerKey: "linear", source: "dynamic" },
      }),
    ]);
    await Promise.all([
      db.clientRegistration.create({
        data: { orgId: setup.org.id, providerKey: "google_workspace", source: "customer" },
      }),
      db.clientRegistration.create({
        data: { orgId: setup.org.id, providerKey: "google_workspace", source: "platform" },
      }),
    ]);
    const [ambiguousGoogle, linear, staticGoogle] = await Promise.all([
      db.connectorConnection.create({
        data: {
          orgId: setup.org.id,
          providerKey: "google_workspace",
          ownerPrincipalId: setup.human.id,
          authMode: "oauth2_code",
          config: {},
          ciphertext: "ambiguous-google",
        },
      }),
      db.connectorConnection.create({
        data: {
          orgId: setup.org.id,
          providerKey: "linear",
          ownerPrincipalId: setup.human.id,
          authMode: "mcp_oauth",
          config: {},
          ciphertext: "unambiguous-linear",
        },
      }),
      db.connectorConnection.create({
        data: {
          orgId: setup.org.id,
          providerKey: "google_workspace",
          ownerPrincipalId: setup.human.id,
          authMode: "api_key",
          config: {},
          ciphertext: "static-google",
        },
      }),
    ]);

    await db.$executeRawUnsafe(
      migrationBlock(clientRegistrationMigration, "connector client registration backfill"),
    );

    await expect(
      db.connectorConnection.findMany({
        where: {
          id: {
            in: [
              setup.humanConnection.id,
              setup.agentConnection.id,
              ambiguousGoogle.id,
              linear.id,
              staticGoogle.id,
            ],
          },
        },
        select: { id: true, clientRegistrationId: true, revokedAt: true },
      }),
    ).resolves.toEqual(
      expect.arrayContaining([
        {
          id: setup.humanConnection.id,
          clientRegistrationId: githubRegistration.id,
          revokedAt: null,
        },
        {
          id: setup.agentConnection.id,
          clientRegistrationId: null,
          revokedAt: expect.any(Date),
        },
        { id: ambiguousGoogle.id, clientRegistrationId: null, revokedAt: expect.any(Date) },
        { id: linear.id, clientRegistrationId: linearRegistration.id, revokedAt: null },
        { id: staticGoogle.id, clientRegistrationId: null, revokedAt: null },
      ]),
    );
  });

  it("reports duplicate active installations without choosing a winner", async () => {
    const setup = await fixture();
    const conflictCheck = migrationBlock(
      conflictPreflight,
      "connector identity conflict preflight",
    );
    await db.$executeRawUnsafe('DROP INDEX "Item_one_active_connector_per_scope_provider"');
    let duplicateIds: string[] = [];
    try {
      const duplicateConnection = await db.connectorConnection.create({
        data: {
          orgId: setup.org.id,
          providerKey: "slack",
          ownerPrincipalId: setup.agent.id,
          authMode: "oauth2_code",
          config: {},
          ciphertext: "migration-fixture-duplicate",
        },
      });
      const rows = await Promise.all(
        [setup.agentConnection.id, duplicateConnection.id].map((connectionId, index) =>
          db.item.create({
            data: {
              orgId: setup.org.id,
              scopeId: setup.orgScope.id,
              kind: "connector",
              title: `Slack ${index + 1}`,
              body: { catalogKey: "slack", connectionId, enabledTools: "all" },
              status: "active",
              disclosure: "retrieved",
              createdById: setup.agent.id,
            },
          }),
        ),
      );
      duplicateIds = rows.map((row) => row.id);

      await expect(db.$executeRawUnsafe(conflictCheck)).rejects.toThrow(
        "connector_identity_conflicts",
      );
      await expect(
        db.item.count({ where: { id: { in: duplicateIds }, status: "active" } }),
      ).resolves.toBe(2);
      expect(conflictCheck).toContain("installationItemIds");
      const duplicateToArchive = duplicateIds[1];
      if (!duplicateToArchive) {
        throw new Error("Expected a duplicate installation fixture");
      }
      await db.item.update({
        where: { id: duplicateToArchive },
        data: { status: "archived" },
      });
      await expect(db.$executeRawUnsafe(conflictCheck)).resolves.toBe(0);
    } finally {
      if (duplicateIds[1]) {
        await db.item.update({ where: { id: duplicateIds[1] }, data: { status: "archived" } });
      }
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "Item_one_active_connector_per_scope_provider"
         ON "Item"("orgId", "scopeId", ("body"->>'catalogKey'))
         WHERE "kind" = 'connector'
           AND "status" <> 'archived'
           AND "body" ? 'catalogKey'`,
      );
    }
  });

  it("reports duplicate active agents without choosing one for attribution", async () => {
    const org = await db.org.create({ data: { name: "Agent conflict fixture" } });
    const conflictCheck = migrationBlock(
      conflictPreflight,
      "connector identity conflict preflight",
    );
    await db.$executeRawUnsafe('DROP INDEX "Principal_one_active_agent_per_org"');
    let duplicateId: string | undefined;
    try {
      await db.principal.create({
        data: { orgId: org.id, kind: "agent", displayName: "First agent" },
      });
      const duplicate = await db.principal.create({
        data: { orgId: org.id, kind: "agent", displayName: "Second agent" },
      });
      duplicateId = duplicate.id;

      await expect(db.$executeRawUnsafe(conflictCheck)).rejects.toThrow(
        "connector_identity_conflicts",
      );
      await expect(
        db.principal.count({
          where: { orgId: org.id, kind: "agent", deactivatedAt: null },
        }),
      ).resolves.toBe(2);
      expect(conflictCheck).toContain("agentPrincipalIds");
      await db.principal.update({
        where: { id: duplicateId },
        data: { deactivatedAt: new Date() },
      });
      await expect(db.$executeRawUnsafe(conflictCheck)).resolves.toBe(0);
    } finally {
      if (duplicateId) {
        await db.principal.update({
          where: { id: duplicateId },
          data: { deactivatedAt: new Date() },
        });
      }
      await db.$executeRawUnsafe(
        `CREATE UNIQUE INDEX "Principal_one_active_agent_per_org"
         ON "Principal"("orgId")
         WHERE "kind" = 'agent' AND "deactivatedAt" IS NULL`,
      );
    }
  });
});
