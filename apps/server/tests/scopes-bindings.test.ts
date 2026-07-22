import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#/generated/prisma/client.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { bindingsRouter } from "#/rpc/bindings.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import { surfacesRouter } from "#/rpc/surfaces.js";
import { resolveLocation } from "#/services/bindings/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("scopes and surface bindings", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "scope-binding-integration-secret-at-least-32-chars",
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
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    return { user, context: { db, auth, env, headers: new Headers({ cookie }) } };
  }

  async function createOrg() {
    const signedUp = await signUp("Surface Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Surface Org" },
      { context: signedUp.context },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    return { ...signedUp, ...membership, orgScope };
  }

  async function addMember(orgId: string, orgScopeId: string, role: Role, name: string) {
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
      data: { orgId, principalId: principal.id, scopeId: orgScopeId, role },
    });
    await db.session.updateMany({
      where: { userId: signedUp.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...signedUp, principal };
  }

  it("resolves explicit bindings, linked DMs, unlinked DMs, and unbound locations", async () => {
    const org = await createOrg();
    const sharedScope = await call(
      scopesRouter.create,
      { name: "Engineering" },
      { context: org.context },
    );
    const first = await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C1", scopeId: sharedScope.id },
      { context: org.context },
    );
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C2", scopeId: sharedScope.id },
      { context: org.context },
    );

    for (const locationRef of ["T1:C1", "T1:C2"]) {
      await expect(
        resolveLocation(db, { orgId: org.org.id, surface: "slack", locationRef }),
      ).resolves.toMatchObject({ kind: "scope", scope: { id: sharedScope.id } });
    }

    const human = await addMember(org.org.id, org.orgScope.id, "member", "Linked Human");
    await db.identityLink.create({
      data: {
        orgId: org.org.id,
        surface: "slack",
        externalUserId: "U-LINKED",
        principalId: human.principal.id,
      },
    });
    const dmInput = {
      orgId: org.org.id,
      surface: "slack",
      locationRef: "T1:D1",
      dm: { externalUserId: "U-LINKED" },
    };
    const personal = await resolveLocation(db, dmInput);
    expect(personal).toMatchObject({
      kind: "scope",
      scope: { kind: "personal", ownerId: human.principal.id, name: "Linked Human" },
    });
    const personalAgain = await resolveLocation(db, dmInput);
    expect(personalAgain.kind).toBe("scope");
    if (personal.kind !== "scope" || personalAgain.kind !== "scope") {
      throw new Error("Linked DM did not resolve to a scope");
    }
    expect(personalAgain.scope.id).toBe(personal.scope.id);
    const dmBindings = await db.binding.findMany({
      where: { orgId: org.org.id, surface: "slack", locationRef: "T1:D1" },
    });
    expect(dmBindings).toHaveLength(1);
    expect(dmBindings[0]?.scopeId).toBe(personal.scope.id);

    await expect(
      resolveLocation(db, {
        orgId: org.org.id,
        surface: "slack",
        locationRef: "T1:D2",
        dm: { externalUserId: "U-UNKNOWN" },
      }),
    ).resolves.toEqual({ kind: "unlinked", surface: "slack", externalUserId: "U-UNKNOWN" });
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "agent" },
    });
    await db.identityLink.create({
      data: {
        orgId: org.org.id,
        surface: "slack",
        externalUserId: "U-AGENT",
        principalId: agent.id,
      },
    });
    await expect(
      resolveLocation(db, {
        orgId: org.org.id,
        surface: "slack",
        locationRef: "T1:D3",
        dm: { externalUserId: "U-AGENT" },
      }),
    ).resolves.toEqual({ kind: "unlinked", surface: "slack", externalUserId: "U-AGENT" });
    await expect(
      resolveLocation(db, {
        orgId: org.org.id,
        surface: "slack",
        locationRef: "T1:UNKNOWN",
      }),
    ).resolves.toEqual({ kind: "unbound" });
    await expect(
      resolveLocation(db, {
        orgId: org.org.id,
        surface: "slack",
        locationRef: "T1:C1",
        dm: { externalUserId: "U-UNKNOWN" },
      }),
    ).resolves.toMatchObject({ kind: "scope", scope: { id: sharedScope.id } });
    expect(first.scopeId).toBe(sharedScope.id);
  });

  it("rejects duplicate locations and personal-scope binding targets", async () => {
    const org = await createOrg();
    const sharedScope = await call(
      scopesRouter.create,
      { name: "Support" },
      { context: org.context },
    );
    const existing = await call(
      bindingsRouter.create,
      { surface: "slack", locationRef: "T1:C1", scopeId: sharedScope.id },
      { context: org.context },
    );
    await expect(
      call(
        bindingsRouter.create,
        { surface: "slack", locationRef: "T1:C1", scopeId: org.orgScope.id },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT", message: expect.stringContaining(existing.id) });

    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        name: "Owner personal",
        ownerId: org.principal.id,
      },
    });
    await expect(
      call(
        bindingsRouter.create,
        { surface: "email", locationRef: "solo", scopeId: personal.id },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("enforces manage_scopes mutations while allowing read-capable members to list", async () => {
    const org = await createOrg();
    const admin = await addMember(org.org.id, org.orgScope.id, "admin", "Admin");
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Member");
    const viewer = await addMember(org.org.id, org.orgScope.id, "viewer", "Viewer");

    await expect(
      call(scopesRouter.create, { name: "Denied" }, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const sharedScope = await call(
      scopesRouter.create,
      { name: "Admin shared scope" },
      { context: admin.context },
    );
    await expect(
      call(
        bindingsRouter.create,
        { surface: "email", locationRef: "member-inbox", scopeId: sharedScope.id },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const binding = await call(
      bindingsRouter.create,
      { surface: "email", locationRef: "admin-inbox", scopeId: sharedScope.id },
      { context: admin.context },
    );

    for (const context of [org.context, admin.context, member.context, viewer.context]) {
      await expect(call(scopesRouter.list, {}, { context })).resolves.toHaveLength(2);
      await expect(call(bindingsRouter.list, {}, { context })).resolves.toHaveLength(1);
    }
    await expect(
      call(scopesRouter.get, { id: sharedScope.id }, { context: viewer.context }),
    ).resolves.toMatchObject({ id: sharedScope.id, kind: "shared" });
    await expect(
      call(bindingsRouter.delete, { id: binding.id }, { context: admin.context }),
    ).resolves.toMatchObject({ id: binding.id });
  });

  it("renames shared scopes but rejects organization and personal scopes", async () => {
    const org = await createOrg();
    const sharedScope = await call(
      scopesRouter.create,
      { name: "Before" },
      { context: org.context },
    );
    await expect(
      call(scopesRouter.rename, { id: sharedScope.id, name: "After" }, { context: org.context }),
    ).resolves.toMatchObject({ id: sharedScope.id, name: "After" });
    await expect(
      call(scopesRouter.rename, { id: org.orgScope.id, name: "No" }, { context: org.context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    const personal = await db.scope.create({
      data: {
        orgId: org.org.id,
        kind: "personal",
        name: "Personal",
        ownerId: org.principal.id,
      },
    });
    await expect(
      call(scopesRouter.rename, { id: personal.id, name: "No" }, { context: org.context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });

  it("lists the surface catalog and rejects an unknown binding surface", async () => {
    const org = await createOrg();
    await expect(call(surfacesRouter.list, undefined, { context: org.context })).resolves.toEqual([
      { id: "slack", name: "Slack", status: "planned" },
      { id: "linear", name: "Linear", status: "planned" },
      { id: "github", name: "GitHub", status: "planned" },
      { id: "email", name: "Email", status: "planned" },
    ]);
    await expect(
      call(
        bindingsRouter.create,
        { surface: "discord", locationRef: "server:channel", scopeId: org.orgScope.id },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: "Unknown surface: discord" });
  });
});
