import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#/generated/prisma/client.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { membersRouter } from "#/rpc/members.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import { authorize, capabilities } from "#/services/authorize/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = describe.skipIf(!testDatabaseUrl);
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("authorization, members, and invites", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "authorization-integration-secret-at-least-32-chars",
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

  async function createOrg(name = "Authorization Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const scope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const principal = await db.principal.findUniqueOrThrow({
      where: { id: membership.principal.id },
    });
    return { ...signedUp, ...membership, principal, scope };
  }

  async function addMember(orgId: string, scopeId: string, role: Role, name = `${role} member`) {
    const signedUp = await signUp(name);
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: signedUp.user.id,
        displayName: name,
        email: signedUp.user.email,
      },
    });
    await db.grant.create({
      data: { orgId, principalId: principal.id, scopeId, role },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...signedUp, principal };
  }

  it("inherits an org role down to a shared scope", async () => {
    const org = await createOrg();
    const admin = await addMember(org.org.id, org.scope.id, "admin");
    const sharedScope = await db.scope.create({
      data: { orgId: org.org.id, kind: "shared", name: "Engineering" },
    });

    await expect(authorize(admin.principal, "manage_members", sharedScope.id, db)).resolves.toBe(
      true,
    );
  });

  it("does not leak a shared-scope grant upward or sideways", async () => {
    const org = await createOrg();
    const user = await signUp("Shared scope member");
    const principal = await db.principal.create({
      data: {
        orgId: org.org.id,
        kind: "human",
        authId: user.user.id,
        displayName: "Shared scope member",
        email: user.user.email,
      },
    });
    const [grantedSpace, otherSpace] = await Promise.all([
      db.scope.create({
        data: { orgId: org.org.id, kind: "shared", name: "One" },
      }),
      db.scope.create({
        data: { orgId: org.org.id, kind: "shared", name: "Two" },
      }),
    ]);
    await db.grant.create({
      data: {
        orgId: org.org.id,
        principalId: principal.id,
        scopeId: grantedSpace.id,
        role: "admin",
      },
    });

    await expect(authorize(principal, "manage_members", grantedSpace.id, db)).resolves.toBe(true);
    await expect(authorize(principal, "manage_members", org.scope.id, db)).resolves.toBe(false);
    await expect(authorize(principal, "manage_members", otherSpace.id, db)).resolves.toBe(false);
  });

  it("gives a personal owner implicit admin without exposing it", async () => {
    const org = await createOrg();
    const owner = await addMember(org.org.id, org.scope.id, "member", "Personal owner");
    const other = await addMember(org.org.id, org.scope.id, "member", "Other member");
    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        name: "Personal owner",
        ownerId: owner.principal.id,
      },
    });

    await expect(authorize(owner.principal, "manage_members", personal.id, db)).resolves.toBe(true);
    await expect(authorize(owner.principal, "manage_org", personal.id, db)).resolves.toBe(false);
    await expect(authorize(other.principal, "read", personal.id, db)).resolves.toBe(false);
  });

  it("denies an agent every capability even with a forged owner grant", async () => {
    const org = await createOrg();
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "agent" },
    });
    await db.grant.create({
      data: {
        orgId: org.org.id,
        principalId: agent.id,
        scopeId: org.scope.id,
        role: "owner",
      },
    });

    for (const capability of capabilities) {
      await expect(authorize(agent, capability, org.scope.id, db)).resolves.toBe(false);
    }
  });

  it("never authorizes a scope id from another org", async () => {
    const first = await createOrg("First Org");
    const second = await createOrg("Second Org");
    await expect(authorize(first.principal, "read", second.scope.id, db)).resolves.toBe(false);
  });

  it("renames an organization as its owner and rejects an admin", async () => {
    const org = await createOrg("Before Rename");
    const admin = await addMember(org.org.id, org.scope.id, "admin", "Rename Admin");

    await expect(
      call(orgRouter.update, { name: "  After Rename  " }, { context: org.context }),
    ).resolves.toMatchObject({ id: org.org.id, name: "After Rename" });
    await expect(
      db.scope.findUniqueOrThrow({ where: { id: org.scope.id } }),
    ).resolves.toMatchObject({ name: "After Rename" });
    await expect(
      db.auditLog.findFirst({ where: { orgId: org.org.id, action: "org.rename" } }),
    ).resolves.toMatchObject({
      actorPrincipalId: org.principal.id,
      subject: org.org.id,
      payload: { previousName: "Before Rename", name: "After Rename" },
    });

    await expect(
      call(orgRouter.update, { name: "Admin Rename" }, { context: admin.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(db.org.findUniqueOrThrow({ where: { id: org.org.id } })).resolves.toMatchObject({
      name: "After Rename",
    });
  });

  it("lists the grant creation time as the member join date", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.scope.id, "member", "Joined Member");
    const grant = await db.grant.findUniqueOrThrow({
      where: {
        orgId_principalId_scopeId: {
          orgId: org.org.id,
          principalId: member.principal.id,
          scopeId: org.scope.id,
        },
      },
    });

    const members = await call(membersRouter.list, undefined, { context: org.context });

    expect(members.find(({ principal }) => principal.id === member.principal.id)).toMatchObject({
      joinedAt: grant.createdAt.toISOString(),
    });
  });

  it("creates and redeems a hash-only invite for a fresh user", async () => {
    const org = await createOrg();
    const created = await call(
      membersRouter.invites.create,
      { role: "member" },
      { context: org.context },
    );
    const token = new URL(created.link).searchParams.get("token");
    if (!token) throw new Error("Invite link did not contain a token");
    const persisted = await db.invite.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(persisted.tokenHash).not.toBe(token);
    expect(JSON.stringify(persisted)).not.toContain(token);
    const createAudit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "invite.create" },
    });
    expect(JSON.stringify(createAudit.payload)).not.toContain(token);

    const joiner = await signUp("Fresh Joiner");
    const redeemed = await call(
      membersRouter.invites.redeem,
      { token },
      { context: joiner.context },
    );
    expect(redeemed).toMatchObject({
      orgId: org.org.id,
      role: "member",
      scopeId: org.scope.id,
      principal: { email: joiner.user.email },
    });
    await expect(
      db.grant.findUnique({
        where: {
          orgId_principalId_scopeId: {
            orgId: org.org.id,
            principalId: redeemed.principal.id,
            scopeId: org.scope.id,
          },
        },
      }),
    ).resolves.toMatchObject({ role: "member" });
    await expect(
      db.auditLog.findFirst({
        where: { action: "invite.redeem", orgId: org.org.id },
      }),
    ).resolves.toMatchObject({ actorPrincipalId: redeemed.principal.id });
    await expect(
      db.scope.findMany({
        where: { orgId: org.org.id, kind: "personal", ownerId: redeemed.principal.id },
      }),
    ).resolves.toEqual([expect.objectContaining({ name: redeemed.principal.displayName })]);
  });

  it("keeps invite personal-scope creation idempotent for an existing principal", async () => {
    const org = await createOrg();
    const invite = await call(
      membersRouter.invites.create,
      { role: "member" },
      { context: org.context },
    );
    const token = new URL(invite.link).searchParams.get("token")!;
    const joiner = await signUp("Existing Joiner");
    const principal = await db.principal.create({
      data: {
        orgId: org.org.id,
        kind: "human",
        authId: joiner.user.id,
        displayName: joiner.user.name,
        email: joiner.user.email,
      },
    });
    const existingScope = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        ownerId: principal.id,
        name: principal.displayName,
      },
    });

    await call(membersRouter.invites.redeem, { token }, { context: joiner.context });

    await expect(
      db.scope.findMany({
        where: { orgId: org.org.id, kind: "personal", ownerId: principal.id },
      }),
    ).resolves.toEqual([expect.objectContaining({ id: existingScope.id })]);
  });

  it("gates invite scopes while disabled and backfills every human exactly once when enabled", async () => {
    const org = await createOrg();
    await call(scopesRouter.setPersonalPolicy, { enabled: false }, { context: org.context });
    await expect(
      db.scope.count({
        where: { orgId: org.org.id, kind: "personal", ownerId: org.principal.id },
      }),
    ).resolves.toBe(1);
    const invite = await call(
      membersRouter.invites.create,
      { role: "member" },
      { context: org.context },
    );
    const token = new URL(invite.link).searchParams.get("token")!;
    const joiner = await signUp("Policy Joiner");
    const redeemed = await call(
      membersRouter.invites.redeem,
      { token },
      { context: joiner.context },
    );

    await expect(
      db.scope.count({
        where: { orgId: org.org.id, kind: "personal", ownerId: redeemed.principal.id },
      }),
    ).resolves.toBe(0);
    await expect(
      db.scope.count({
        where: { orgId: org.org.id, kind: "personal", ownerId: org.principal.id },
      }),
    ).resolves.toBe(1);

    await call(scopesRouter.setPersonalPolicy, { enabled: true }, { context: org.context });
    await call(scopesRouter.setPersonalPolicy, { enabled: true }, { context: org.context });

    const personalScopes = await db.scope.findMany({
      where: { orgId: org.org.id, kind: "personal" },
      orderBy: { ownerId: "asc" },
    });
    expect(personalScopes).toHaveLength(2);
    expect(personalScopes.map(({ ownerId }) => ownerId)).toEqual(
      [org.principal.id, redeemed.principal.id].sort(),
    );
  });

  it("rejects expired and double-redeemed invites with conflicts", async () => {
    const org = await createOrg();
    const expired = await call(
      membersRouter.invites.create,
      { role: "viewer", expiresAt: new Date(Date.now() + 60_000).toISOString() },
      { context: org.context },
    );
    await db.invite.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    const expiredToken = new URL(expired.link).searchParams.get("token")!;
    const firstJoiner = await signUp("Expired Joiner");
    await expect(
      call(membersRouter.invites.redeem, { token: expiredToken }, { context: firstJoiner.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const valid = await call(
      membersRouter.invites.create,
      { role: "viewer" },
      { context: org.context },
    );
    const validToken = new URL(valid.link).searchParams.get("token")!;
    await call(
      membersRouter.invites.redeem,
      { token: validToken },
      { context: firstJoiner.context },
    );
    const secondJoiner = await signUp("Second Joiner");
    await expect(
      call(membersRouter.invites.redeem, { token: validToken }, { context: secondJoiner.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("previews a valid invite and rejects consumed or unknown tokens", async () => {
    const org = await createOrg("Preview Org");
    const created = await call(
      membersRouter.invites.create,
      { role: "member" },
      { context: org.context },
    );
    const token = new URL(created.link).searchParams.get("token")!;
    const anonymousContext = { db, auth, env, headers: new Headers() };
    await expect(
      call(membersRouter.invites.preview, { token }, { context: anonymousContext }),
    ).resolves.toEqual({
      orgName: "Preview Org",
      invitedBy: org.principal.displayName,
    });

    await expect(
      call(
        membersRouter.invites.preview,
        { token: "unknown-token" },
        { context: anonymousContext },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });

    const joiner = await signUp("Preview Joiner");
    await call(membersRouter.invites.redeem, { token }, { context: joiner.context });
    await expect(
      call(membersRouter.invites.preview, { token }, { context: anonymousContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("lists only pending invites and enforces the revoke lifecycle", async () => {
    const org = await createOrg("Invite Lifecycle Org");
    const pending = await call(
      membersRouter.invites.create,
      { role: "member" },
      { context: org.context },
    );
    const revoked = await call(
      membersRouter.invites.create,
      { role: "viewer" },
      { context: org.context },
    );
    const redeemed = await call(
      membersRouter.invites.create,
      { role: "admin" },
      { context: org.context },
    );
    const expired = await call(
      membersRouter.invites.create,
      { role: "member" },
      { context: org.context },
    );
    const redeemedToken = new URL(redeemed.link).searchParams.get("token")!;
    const revokedToken = new URL(revoked.link).searchParams.get("token")!;
    const joiner = await signUp("Redeemed invite member");

    await call(membersRouter.invites.redeem, { token: redeemedToken }, { context: joiner.context });
    await call(membersRouter.invites.revoke, { id: revoked.id }, { context: org.context });
    await db.invite.update({
      where: { id: expired.id },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });

    await expect(
      call(membersRouter.invites.list, undefined, { context: org.context }),
    ).resolves.toEqual([
      expect.objectContaining({
        id: pending.id,
        role: "member",
        invitedBy: org.principal.displayName,
      }),
    ]);
    const anonymousContext = { db, auth, env, headers: new Headers() };
    await expect(
      call(membersRouter.invites.preview, { token: revokedToken }, { context: anonymousContext }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      call(membersRouter.invites.redeem, { token: revokedToken }, { context: joiner.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      call(membersRouter.invites.revoke, { id: revoked.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      call(membersRouter.invites.revoke, { id: redeemed.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.auditLog.findFirst({ where: { orgId: org.org.id, action: "invite.revoke" } }),
    ).resolves.toMatchObject({ actorPrincipalId: org.principal.id, subject: revoked.id });
  });

  it("deactivates and reactivates a human without restoring severed access", async () => {
    const org = await createOrg("Member Lifecycle Org");
    const member = await addMember(org.org.id, org.scope.id, "member", "Lifecycle Member");
    const credential = await db.serviceCredential.create({
      data: {
        orgId: org.org.id,
        principalId: member.principal.id,
        name: "Member credential",
        tokenHash: randomUUID(),
        createdById: org.principal.id,
      },
    });
    const identityLink = await db.identityLink.create({
      data: {
        orgId: org.org.id,
        principalId: member.principal.id,
        surface: "slack",
        externalUserId: randomUUID(),
      },
    });

    await expect(
      call(membersRouter.deactivate, { id: member.principal.id }, { context: org.context }),
    ).resolves.toEqual({ id: member.principal.id, status: "deactivated" });
    await expect(
      db.principal.findUniqueOrThrow({ where: { id: member.principal.id } }),
    ).resolves.toMatchObject({ deactivatedAt: expect.any(Date) });
    await expect(
      db.serviceCredential.findUniqueOrThrow({ where: { id: credential.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(
      db.identityLink.findUnique({ where: { id: identityLink.id } }),
    ).resolves.toBeNull();
    await expect(
      db.grant.findUnique({
        where: {
          orgId_principalId_scopeId: {
            orgId: org.org.id,
            principalId: member.principal.id,
            scopeId: org.scope.id,
          },
        },
      }),
    ).resolves.toMatchObject({ role: "member" });
    await expect(
      call(membersRouter.list, undefined, { context: org.context }),
    ).resolves.toContainEqual(
      expect.objectContaining({
        principal: expect.objectContaining({ id: member.principal.id }),
        status: "deactivated",
      }),
    );
    await expect(
      call(membersRouter.list, undefined, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(membersRouter.deactivate, { id: member.principal.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await expect(
      call(membersRouter.reactivate, { id: member.principal.id }, { context: org.context }),
    ).resolves.toEqual({ id: member.principal.id, status: "active" });
    await expect(
      db.principal.findUniqueOrThrow({ where: { id: member.principal.id } }),
    ).resolves.toMatchObject({ deactivatedAt: null });
    await expect(
      db.serviceCredential.findUniqueOrThrow({ where: { id: credential.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(
      db.identityLink.findUnique({ where: { id: identityLink.id } }),
    ).resolves.toBeNull();
    await expect(
      call(membersRouter.reactivate, { id: member.principal.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
    await expect(
      db.auditLog.findMany({
        where: {
          orgId: org.org.id,
          action: { in: ["principal.deactivate", "principal.reactivate"] },
        },
        orderBy: { createdAt: "asc" },
      }),
    ).resolves.toMatchObject([
      { actorPrincipalId: org.principal.id, subject: member.principal.id },
      { actorPrincipalId: org.principal.id, subject: member.principal.id },
    ]);
  });

  it("blocks deactivating the last active owner and rejects agent principals", async () => {
    const org = await createOrg("Protected Owner Org");
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "agent" },
    });

    await expect(
      call(membersRouter.deactivate, { id: org.principal.id }, { context: org.context }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The organization's last owner cannot be deactivated",
    });
    await expect(
      call(membersRouter.deactivate, { id: agent.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("does not let an invite reactivate a deactivated member", async () => {
    const org = await createOrg("Invite Reactivation Org");
    const member = await addMember(org.org.id, org.scope.id, "member", "Deactivated Joiner");
    const invite = await call(
      membersRouter.invites.create,
      { role: "admin" },
      { context: org.context },
    );
    const token = new URL(invite.link).searchParams.get("token")!;
    await call(membersRouter.deactivate, { id: member.principal.id }, { context: org.context });

    await expect(
      call(membersRouter.invites.redeem, { token }, { context: member.context }),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "A deactivated member cannot redeem an invite",
    });
    await expect(db.invite.findUniqueOrThrow({ where: { id: invite.id } })).resolves.toMatchObject({
      redeemedAt: null,
    });
  });

  it("does not count a deactivated owner toward the last-owner role guard", async () => {
    const org = await createOrg("Active Owner Guard Org");
    const otherOwner = await addMember(org.org.id, org.scope.id, "owner", "Other Owner");
    await call(membersRouter.deactivate, { id: otherOwner.principal.id }, { context: org.context });

    await expect(
      call(
        membersRouter.setRole,
        { principalId: org.principal.id, role: "admin" },
        { context: org.context },
      ),
    ).rejects.toMatchObject({
      code: "CONFLICT",
      message: "The organization's last owner cannot be demoted",
    });
  });

  it("sets roles, protects the last owner, and gates member management", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.scope.id, "member");
    await expect(
      call(
        membersRouter.setRole,
        { principalId: member.principal.id, role: "admin" },
        { context: org.context },
      ),
    ).resolves.toMatchObject({
      role: "admin",
      principal: { id: member.principal.id },
    });
    await expect(
      db.auditLog.findFirst({
        where: { orgId: org.org.id, action: "grant.set_role" },
      }),
    ).resolves.toMatchObject({ actorPrincipalId: org.principal.id });

    await expect(
      call(
        membersRouter.setRole,
        { principalId: org.principal.id, role: "admin" },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    await db.grant.update({
      where: {
        orgId_principalId_scopeId: {
          orgId: org.org.id,
          principalId: member.principal.id,
          scopeId: org.scope.id,
        },
      },
      data: { role: "member" },
    });
    await expect(
      call(
        membersRouter.setRole,
        { principalId: org.principal.id, role: "viewer" },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});
