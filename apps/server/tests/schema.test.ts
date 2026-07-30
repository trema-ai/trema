import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "#server/lib/db/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("database schema", () => {
  const db = createPrismaClient(databaseUrl);

  afterAll(async () => {
    await db.$disconnect();
  });

  it("allows only one org-kind scope per org", async () => {
    const firstOrg = await db.org.create({ data: { name: "First org" } });
    const secondOrg = await db.org.create({ data: { name: "Second org" } });

    await db.scope.create({
      data: {
        orgId: firstOrg.id,
        kind: "org",
        name: "First org root",
      },
    });

    await expect(
      db.scope.create({
        data: {
          orgId: firstOrg.id,
          kind: "org",
          name: "Duplicate root",
        },
      }),
    ).rejects.toThrow();

    await expect(
      db.scope.create({
        data: {
          orgId: secondOrg.id,
          kind: "org",
          name: "Second org root",
        },
      }),
    ).resolves.toMatchObject({ orgId: secondOrg.id });
  });

  it("allows only one personal scope per human in an org", async () => {
    const org = await db.org.create({ data: { name: "Personal scope org" } });
    const human = await db.principal.create({
      data: { orgId: org.id, kind: "human", displayName: "Human" },
    });
    await db.scope.create({
      data: { orgId: org.id, kind: "personal", name: "Human", ownerId: human.id },
    });

    await expect(
      db.scope.create({
        data: { orgId: org.id, kind: "personal", name: "Duplicate", ownerId: human.id },
      }),
    ).rejects.toThrow();
  });

  it("allows at most one active agent principal per org", async () => {
    const firstOrg = await db.org.create({ data: { name: "Agent identity org" } });
    const secondOrg = await db.org.create({ data: { name: "Second agent identity org" } });

    await db.principal.create({
      data: { orgId: firstOrg.id, kind: "agent", displayName: "Active agent" },
    });

    await expect(
      db.principal.create({
        data: { orgId: firstOrg.id, kind: "agent", displayName: "Duplicate active agent" },
      }),
    ).rejects.toThrow();

    await expect(
      db.principal.create({
        data: {
          orgId: firstOrg.id,
          kind: "agent",
          displayName: "Historical agent",
          deactivatedAt: new Date(),
        },
      }),
    ).resolves.toMatchObject({ orgId: firstOrg.id, kind: "agent" });

    await expect(
      db.principal.create({
        data: { orgId: secondOrg.id, kind: "agent", displayName: "Other org agent" },
      }),
    ).resolves.toMatchObject({ orgId: secondOrg.id, kind: "agent" });
  });

  it("allows only one active instruction per scope", async () => {
    const org = await db.org.create({ data: { name: "Instruction org" } });
    const human = await db.principal.create({
      data: { orgId: org.id, kind: "human", displayName: "Human" },
    });
    const scope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Instruction org root" },
    });
    const otherScope = await db.scope.create({
      data: { orgId: org.id, kind: "shared", name: "Engineering" },
    });

    function instruction(scopeId: string, title: string, status: "proposed" | "active") {
      return db.item.create({
        data: {
          orgId: org.id,
          scopeId,
          kind: "instruction",
          title,
          body: { content: title },
          status,
          disclosure: "standing",
          createdById: human.id,
        },
      });
    }

    await instruction(scope.id, "First active", "active");
    await expect(instruction(scope.id, "Second active", "active")).rejects.toThrow();
    await expect(instruction(scope.id, "Proposed", "proposed")).resolves.toMatchObject({
      status: "proposed",
    });
    await expect(instruction(otherScope.id, "Other scope", "active")).resolves.toMatchObject({
      scopeId: otherScope.id,
    });
  });
});
