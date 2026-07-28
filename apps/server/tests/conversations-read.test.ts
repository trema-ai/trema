import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Principal, Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { conversationsRouter } from "#server/rpc/conversations.js";
import { orgRouter } from "#server/rpc/org.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("conversation reads", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "conversation-read-integration-secret-32-characters",
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
    const signedUp = await signUp("Conversation Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Conversation Org" },
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

  async function personalScope(orgId: string, owner: Principal) {
    return db.scope.create({
      data: { orgId, kind: "personal", name: owner.displayName, ownerId: owner.id },
    });
  }

  async function conversation(options: {
    orgId: string;
    scopeId: string;
    surface: string;
    locationRef: string;
    threadRef: string;
    lastActivityAt: Date;
    messages: { seq: number; text: string }[];
  }) {
    const row = await db.conversation.create({
      data: {
        orgId: options.orgId,
        scopeId: options.scopeId,
        surface: options.surface,
        locationRef: options.locationRef,
        threadRef: options.threadRef,
        startedAt: new Date(options.lastActivityAt.getTime() - 60_000),
        lastActivityAt: options.lastActivityAt,
      },
    });
    for (const message of options.messages) {
      await db.message.create({
        data: {
          orgId: options.orgId,
          conversationId: row.id,
          seq: message.seq,
          surfaceMessageRef: `ref-${message.seq}`,
          authorExternalRef: "someone",
          sentAt: new Date(options.lastActivityAt.getTime() - 60_000 + message.seq),
          text: message.text,
        },
      });
    }
    return row;
  }

  async function setup() {
    const org = await createOrg();
    const alice = await addMember(org.org.id, org.orgScope.id, "member", "Alice");
    const bob = await addMember(org.org.id, org.orgScope.id, "member", "Bob");
    const aliceScope = await personalScope(org.org.id, alice.principal);
    const bobScope = await personalScope(org.org.id, bob.principal);
    return { org, alice, bob, aliceScope, bobScope };
  }

  it("lists the caller's own conversations, newest activity first, titled by first message", async () => {
    const { org, alice, bob, aliceScope, bobScope } = await setup();
    const older = await conversation({
      orgId: org.org.id,
      scopeId: aliceScope.id,
      surface: "web",
      locationRef: `member-${alice.principal.id}`,
      threadRef: "thread-older",
      lastActivityAt: new Date("2026-07-20T12:00:00.000Z"),
      messages: [
        { seq: 1, text: "How do I rotate the deploy key?" },
        { seq: 2, text: "Like this." },
      ],
    });
    const newer = await conversation({
      orgId: org.org.id,
      scopeId: aliceScope.id,
      surface: "web",
      locationRef: `member-${alice.principal.id}`,
      threadRef: "thread-newer",
      lastActivityAt: new Date("2026-07-21T12:00:00.000Z"),
      // The first message was retracted: the earliest surviving one titles it.
      messages: [{ seq: 2, text: "Second message, first survivor." }],
    });
    // Another member's conversation and an org-scope one must never appear.
    await conversation({
      orgId: org.org.id,
      scopeId: bobScope.id,
      surface: "web",
      locationRef: `member-${bob.principal.id}`,
      threadRef: "thread-bob",
      lastActivityAt: new Date("2026-07-22T12:00:00.000Z"),
      messages: [{ seq: 1, text: "Bob's private question." }],
    });
    await conversation({
      orgId: org.org.id,
      scopeId: org.orgScope.id,
      surface: "slack",
      locationRef: "C123",
      threadRef: "1700000000.000100",
      lastActivityAt: new Date("2026-07-23T12:00:00.000Z"),
      messages: [{ seq: 1, text: "Org-scope chatter." }],
    });

    const listed = await call(conversationsRouter.list, {}, { context: alice.context });

    expect(listed.conversations.map(({ id }) => id)).toEqual([newer.id, older.id]);
    expect(listed.conversations[0]).toMatchObject({
      surface: "web",
      threadRef: "thread-newer",
      firstMessageText: "Second message, first survivor.",
      lastActivityAt: "2026-07-21T12:00:00.000Z",
    });
    expect(listed.conversations[1]?.firstMessageText).toBe("How do I rotate the deploy key?");
    const texts = JSON.stringify(listed);
    expect(texts).not.toContain("Bob's private question.");
    expect(texts).not.toContain("Org-scope chatter.");
  });

  it("filters by surface", async () => {
    const { org, alice, aliceScope } = await setup();
    const web = await conversation({
      orgId: org.org.id,
      scopeId: aliceScope.id,
      surface: "web",
      locationRef: `member-${alice.principal.id}`,
      threadRef: "thread-web",
      lastActivityAt: new Date("2026-07-20T12:00:00.000Z"),
      messages: [{ seq: 1, text: "From the web." }],
    });
    await conversation({
      orgId: org.org.id,
      scopeId: aliceScope.id,
      surface: "slack",
      locationRef: "D456",
      threadRef: "",
      lastActivityAt: new Date("2026-07-21T12:00:00.000Z"),
      messages: [{ seq: 1, text: "From a direct message." }],
    });

    const listed = await call(
      conversationsRouter.list,
      { surface: "web" },
      { context: alice.context },
    );

    expect(listed.conversations.map(({ id }) => id)).toEqual([web.id]);
  });

  it("answers a member with no personal scope with an empty list", async () => {
    const org = await createOrg();
    const carol = await addMember(org.org.id, org.orgScope.id, "member", "Carol");

    const listed = await call(conversationsRouter.list, {}, { context: carol.context });

    expect(listed).toEqual({ conversations: [] });
  });

  it("never shows an admin another member's conversations", async () => {
    const { org, alice, aliceScope } = await setup();
    await conversation({
      orgId: org.org.id,
      scopeId: aliceScope.id,
      surface: "web",
      locationRef: `member-${alice.principal.id}`,
      threadRef: "thread-private",
      lastActivityAt: new Date("2026-07-20T12:00:00.000Z"),
      messages: [{ seq: 1, text: "Alice's private question." }],
    });

    // The org owner's list reads their own personal scope, which holds
    // nothing: the role never widens an owner-scoped read.
    const listed = await call(conversationsRouter.list, {}, { context: org.context });

    expect(listed).toEqual({ conversations: [] });
  });
});
