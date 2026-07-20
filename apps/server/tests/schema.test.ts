import { afterAll, describe, expect, it } from "vitest";

import { createPrismaClient } from "../src/lib/db/index.js";

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
});
