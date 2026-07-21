import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#/generated/prisma/client.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { serviceCredentialsRouter } from "#/rpc/credentials.js";
import { orgRouter } from "#/rpc/org.js";
import { hashServiceCredentialToken } from "#/services/credentials/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("service credentials", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "service-credential-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
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
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    if (!cookie) {
      throw new Error("Sign-up did not return a session cookie");
    }
    return {
      user,
      context: { db, auth, env, headers: new Headers({ cookie }) },
    };
  }

  async function createOrg(name: string) {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const scope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    return { ...signedUp, ...membership, scope };
  }

  async function addMember(
    org: Awaited<ReturnType<typeof createOrg>>,
    role: Role,
    name = `${role} member`,
  ) {
    const signedUp = await signUp(name);
    const principal = await db.principal.create({
      data: {
        orgId: org.org.id,
        kind: "human",
        authId: signedUp.user.id,
        displayName: name,
        email: signedUp.user.email,
      },
    });
    await db.grant.create({
      data: {
        orgId: org.org.id,
        principalId: principal.id,
        scopeId: org.scope.id,
        role,
      },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: org.org.id },
    });
    return { ...signedUp, principal };
  }

  function serviceContext(secret?: string) {
    const headers = new Headers();
    if (secret) headers.set("authorization", `Bearer ${secret}`);
    return { db, auth, env, headers };
  }

  it("stores only the SHA-256 hash and resolves to the org agent principal", async () => {
    const org = await createOrg("Hash Only Org");
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "agent" },
    });

    const created = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: org.context },
    );
    expect(created.secret).toMatch(/^trema_sc_/);

    const persisted = await db.serviceCredential.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.tokenHash).toBe(hashServiceCredentialToken(created.secret));
    expect(JSON.stringify(persisted)).not.toContain(created.secret);

    await expect(
      call(serviceCredentialsRouter.whoami, undefined, {
        context: serviceContext(created.secret),
      }),
    ).resolves.toEqual({
      orgId: org.org.id,
      principal: {
        id: agent.id,
        kind: "agent",
        displayName: agent.displayName,
      },
    });
  });

  it("rejects revoked, unknown, and malformed service authentication", async () => {
    const org = await createOrg("Rejected Tokens Org");
    const created = await call(
      serviceCredentialsRouter.create,
      { name: "Soon revoked" },
      { context: org.context },
    );
    await call(
      serviceCredentialsRouter.revoke,
      { credentialId: created.id },
      { context: org.context },
    );

    await expect(
      call(serviceCredentialsRouter.whoami, undefined, {
        context: serviceContext(created.secret),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(serviceCredentialsRouter.whoami, undefined, {
        context: serviceContext("trema_sc_unknown"),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(serviceCredentialsRouter.whoami, undefined, {
        context: serviceContext(),
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(
      call(serviceCredentialsRouter.whoami, undefined, {
        context: { ...serviceContext(), headers: new Headers({ authorization: "Basic token" }) },
      }),
    ).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("isolates listing and revocation by active org while each token resolves its own org", async () => {
    const first = await createOrg("First Credential Org");
    const second = await createOrg("Second Credential Org");
    const secondAgent = await db.principal.findFirstOrThrow({
      where: { orgId: second.org.id, kind: "agent" },
    });
    const secondCredential = await call(
      serviceCredentialsRouter.create,
      { name: "Second org token" },
      { context: second.context },
    );

    await expect(
      call(serviceCredentialsRouter.list, undefined, { context: first.context }),
    ).resolves.toEqual([]);
    await expect(
      call(
        serviceCredentialsRouter.revoke,
        { credentialId: secondCredential.id },
        { context: first.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(serviceCredentialsRouter.whoami, undefined, {
        context: serviceContext(secondCredential.secret),
      }),
    ).resolves.toMatchObject({
      orgId: second.org.id,
      principal: { id: secondAgent.id },
    });
  });

  it("allows owners and admins but denies members for credential management", async () => {
    const org = await createOrg("Capability Org");
    const admin = await addMember(org, "admin");
    const member = await addMember(org, "member");

    const ownerCredential = await call(
      serviceCredentialsRouter.create,
      { name: "Owner-created" },
      { context: org.context },
    );
    await expect(
      call(serviceCredentialsRouter.list, undefined, { context: org.context }),
    ).resolves.toHaveLength(1);

    const adminCredential = await call(
      serviceCredentialsRouter.create,
      { name: "Admin-created" },
      { context: admin.context },
    );
    await expect(
      call(serviceCredentialsRouter.list, undefined, { context: admin.context }),
    ).resolves.toHaveLength(2);
    await expect(
      call(
        serviceCredentialsRouter.revoke,
        { credentialId: ownerCredential.id },
        { context: admin.context },
      ),
    ).resolves.toMatchObject({ id: ownerCredential.id, revokedAt: expect.any(String) });

    await expect(
      call(
        serviceCredentialsRouter.create,
        { name: "Member-created" },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(serviceCredentialsRouter.list, undefined, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        serviceCredentialsRouter.revoke,
        { credentialId: adminCredential.id },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("writes create and revoke audits without secret material", async () => {
    const org = await createOrg("Audit Org");
    const created = await call(
      serviceCredentialsRouter.create,
      { name: "Audited token" },
      { context: org.context },
    );
    const persisted = await db.serviceCredential.findUniqueOrThrow({ where: { id: created.id } });
    await call(
      serviceCredentialsRouter.revoke,
      { credentialId: created.id },
      { context: org.context },
    );

    const audits = await db.auditLog.findMany({
      where: {
        orgId: org.org.id,
        subject: created.id,
        action: { in: ["service_credential.create", "service_credential.revoke"] },
      },
      orderBy: { createdAt: "asc" },
    });
    expect(audits).toHaveLength(2);
    expect(audits.map(({ action }) => action)).toEqual([
      "service_credential.create",
      "service_credential.revoke",
    ]);
    expect(JSON.stringify(audits)).not.toContain(created.secret);
    expect(JSON.stringify(audits)).not.toContain(persisted.tokenHash);
  });
});
