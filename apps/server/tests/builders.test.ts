import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, describe, expect, it } from "vitest";

import { createAuth } from "../src/lib/auth/index.js";
import { createPrismaClient } from "../src/lib/db/index.js";
import { parseEnv } from "../src/lib/env/schema.js";
import { orgScoped } from "../src/rpc/builders.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("orgScoped", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "integration-test-auth-secret-at-least-32-characters",
  });
  const auth = createAuth({
    db,
    env,
  });
  const currentContext = orgScoped.handler(({ context }) => ({
    orgId: context.org.id,
    principalId: context.principal.id,
  }));

  afterAll(async () => {
    await db.$disconnect();
  });

  async function createSession(): Promise<{
    cookie: string;
    userId: string;
  }> {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: {
        name: "Scoped User",
        email,
        password: "integration-password",
      },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    const user = await db.user.findUniqueOrThrow({ where: { email } });

    if (!cookie) {
      throw new Error("Sign-up did not return a session cookie");
    }

    return { cookie, userId: user.id };
  }

  async function setActiveOrg(userId: string, activeOrgId: string): Promise<void> {
    await db.session.updateMany({
      where: { userId },
      data: { activeOrgId },
    });
  }

  it("resolves the principal in the active org for a two-org user", async () => {
    const { cookie, userId } = await createSession();
    const firstOrg = await db.org.create({ data: { name: "First membership" } });
    const secondOrg = await db.org.create({ data: { name: "Active membership" } });
    await db.principal.create({
      data: {
        orgId: firstOrg.id,
        kind: "human",
        displayName: "First principal",
        authId: userId,
      },
    });
    const activePrincipal = await db.principal.create({
      data: {
        orgId: secondOrg.id,
        kind: "human",
        displayName: "Active principal",
        authId: userId,
      },
    });
    await setActiveOrg(userId, secondOrg.id);

    await expect(
      call(currentContext, undefined, {
        context: {
          db,
          auth,
          env,
          headers: new Headers({ cookie }),
        },
      }),
    ).resolves.toEqual({
      orgId: secondOrg.id,
      principalId: activePrincipal.id,
    });
  });

  it("rejects a session without an active org", async () => {
    const { cookie } = await createSession();
    await db.org.create({ data: { name: `No active org ${randomUUID()}` } });

    await expect(
      call(currentContext, undefined, {
        context: {
          db,
          auth,
          env,
          headers: new Headers({ cookie }),
        },
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "No active organization",
    });
  });

  it("rejects a user without a principal in the active org", async () => {
    const { cookie, userId } = await createSession();
    const org = await db.org.create({
      data: { name: `Missing principal ${randomUUID()}` },
    });
    await setActiveOrg(userId, org.id);

    await expect(
      call(currentContext, undefined, {
        context: {
          db,
          auth,
          env,
          headers: new Headers({ cookie }),
        },
      }),
    ).rejects.toMatchObject({
      code: "FORBIDDEN",
      message: "Principal not found in active organization",
    });
  });
});
