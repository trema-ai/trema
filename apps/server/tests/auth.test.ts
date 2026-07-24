import { randomUUID } from "node:crypto";

import { afterAll, describe, expect, it } from "vitest";

import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("better-auth", () => {
  const db = createPrismaClient(databaseUrl);
  const auth = createAuth({
    db,
    env: parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      TREMA_MODE: "hosted",
      TREMA_AUTH_SECRET: "integration-test-auth-secret-at-least-32-characters",
    }),
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  it("signs up a user and resolves the resulting session", async () => {
    await db.org.create({ data: { name: `Auth test ${randomUUID()}` } });
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: {
        name: "Auth Test",
        email,
        password: "integration-password",
      },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];

    expect(response.status).toBe(200);
    expect(cookie).toBeTruthy();

    const session = await auth.api.getSession({
      headers: new Headers({ cookie: cookie ?? "" }),
    });

    expect(session).toMatchObject({
      user: { email },
      session: { activeOrgId: null },
    });
  });

  it("syncs an updated user name to every human principal", async () => {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: {
        name: "Original Name",
        email,
        password: "integration-password",
      },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) {
      throw new Error("Sign-up did not return a session cookie");
    }
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const orgs = await Promise.all([
      db.org.create({ data: { name: `Name sync one ${randomUUID()}` } }),
      db.org.create({ data: { name: `Name sync two ${randomUUID()}` } }),
    ]);
    await Promise.all(
      orgs.map((org) =>
        db.principal.create({
          data: {
            orgId: org.id,
            kind: "human",
            authId: user.id,
            displayName: user.name,
            email,
          },
        }),
      ),
    );

    await auth.api.updateUser({
      body: { name: "Updated Name" },
      headers: new Headers({ cookie }),
    });

    const principals = await db.principal.findMany({
      where: { authId: user.id, kind: "human" },
    });
    expect(principals).toHaveLength(2);
    expect(principals.every(({ displayName }) => displayName === "Updated Name")).toBe(true);
  });
});
