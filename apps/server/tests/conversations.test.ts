import { randomUUID } from "node:crypto";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createApp } from "#/app.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { bindingsRouter } from "#/rpc/bindings.js";
import { serviceCredentialsRouter } from "#/rpc/credentials.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import { sessionsRouter } from "#/rpc/sessions.js";
import { FETCH_TRANSCRIPT_MAX_WINDOW } from "#/services/dataplane/transcript.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const MCP_URL = "http://context.test/api/v1/mcp";

interface ReportedMessage {
  surfaceMessageRef: string;
  operation?: "upsert" | "delete";
  author?: { principalId?: string; externalRef?: string };
  sentAt?: string;
  text?: string;
}

interface Transcript {
  conversationId: string;
  messageCount: number;
  firstSeq: number | null;
  lastSeq: number | null;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  participants: { principalId: string | null; externalRef: string | null }[];
  messages: { seq: number; text: string; authorPrincipalId: string | null }[];
}

integration("conversation capture", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "conversation-integration-secret-at-least-32-chars",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
  });
  const auth = createAuth({ db, env });
  const app = createApp({ db, auth, env });

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

  async function createOrg(name = "Conversation Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: signedUp.context },
    );
    return { ...signedUp, ...membership, orgScope, credential };
  }

  type Org = Awaited<ReturnType<typeof createOrg>>;

  async function linkMember(org: Org, name: string, externalUserId: string) {
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
        scopeId: org.orgScope.id,
        role: "member",
      },
    });
    await db.identityLink.create({
      data: { orgId: org.org.id, surface: "slack", externalUserId, principalId: principal.id },
    });
    return { ...signedUp, principal };
  }

  function serviceContext(secret: string) {
    return { db, auth, env, headers: new Headers({ authorization: `Bearer ${secret}` }) };
  }

  function sessionContext(token: string) {
    return { db, auth, env, headers: new Headers({ authorization: `Bearer ${token}` }) };
  }

  /** Bind a channel to a fresh shared scope. */
  async function bindChannel(org: Org, name: string, locationRef: string) {
    const scope = await call(scopesRouter.create, { name }, { context: org.context });
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef, scopeId: scope.id },
      { context: org.context },
    );
    return scope;
  }

  function openSession(org: Org, locationRef: string, threadRef?: string) {
    return call(
      sessionsRouter.open,
      { surface: "slack", locationRef, ...(threadRef ? { threadRef } : {}) },
      { context: serviceContext(org.credential.secret) },
    );
  }

  function report(
    session: { sessionId: string; sessionToken: string },
    messages: ReportedMessage[],
  ) {
    return call(
      sessionsRouter.messages,
      { id: session.sessionId, messages },
      { context: sessionContext(session.sessionToken) },
    );
  }

  /** A message an hour into the epoch's day, so ordering in a batch is readable. */
  function said(ref: string, text: string, author = "U-ASKS"): ReportedMessage {
    return {
      surfaceMessageRef: ref,
      author: { externalRef: author },
      sentAt: new Date(Date.UTC(2026, 6, 24, 9, Number(ref.split("-")[1] ?? 0))).toISOString(),
      text,
    };
  }

  async function connect(sessionToken: string) {
    const client = new Client({ name: "conversation-test", version: "1.0.0" });
    const transport = new StreamableHTTPClientTransport(new URL(MCP_URL), {
      requestInit: { headers: { authorization: `Bearer ${sessionToken}` } },
      fetch: async (url, init) => app.fetch(new Request(url, init)),
    });
    await client.connect(transport as Parameters<Client["connect"]>[0]);
    return client;
  }

  async function transcript(
    client: Client,
    args: { conversationId: string; aroundSeq?: number; window?: number },
  ): Promise<CallToolResult> {
    return (await client.callTool({ name: "fetch_transcript", arguments: args })) as CallToolResult;
  }

  // The lexical index is not queried by any tool yet — digests are what bridge
  // conversations into item search — so the test reads it the way the
  // distillation pass will.
  async function indexedMatches(orgId: string, query: string): Promise<string[]> {
    const rows = await db.$queryRaw<{ text: string }[]>`
      SELECT d."text"
      FROM "MessageSearchDoc" d,
           websearch_to_tsquery('trema_multilingual'::regconfig, ${query}) q
      WHERE d."orgId" = ${orgId} AND d."tsv" @@ q
      ORDER BY d."text"
    `;
    return rows.map((row) => row.text);
  }

  it("extends one conversation per thread and starts another for a new thread", async () => {
    const org = await createOrg();
    const scope = await bindChannel(org, "Support", "T1:C1");
    const member = await linkMember(org, "Asking Human", "U-ASKS");

    const first = await openSession(org, "T1:C1", "thread-1");
    const opening = await report(first, [
      said("m-1", "The kingfisher deploy failed on the staging cluster"),
      said("m-2", "Rolling it back now", "U-AGENT"),
    ]);
    expect(opening).toMatchObject({ created: 2, updated: 0, scopeId: scope.id });
    expect(opening.results.map(({ seq }) => seq)).toEqual([1, 2]);

    // A second session on the same thread continues the same conversation, and
    // numbering picks up where the first left off.
    const second = await openSession(org, "T1:C1", "thread-1");
    const continued = await report(second, [said("m-3", "The rollback finished")]);
    expect(continued.conversationId).toBe(opening.conversationId);
    expect(continued.results[0]?.seq).toBe(3);
    expect(continued.messageCount).toBe(3);

    // A different thread in the same channel is a different conversation.
    const other = await openSession(org, "T1:C1", "thread-2");
    const separate = await report(other, [said("m-4", "Unrelated question about invoices")]);
    expect(separate.conversationId).not.toBe(opening.conversationId);
    expect(separate.results[0]?.seq).toBe(1);

    // A session with no thread at all still lands one conversation: the
    // location stands in for the thread.
    const unthreaded = await openSession(org, "T1:C1");
    const flat = await report(unthreaded, [said("m-5", "A channel message outside any thread")]);
    expect(flat.threadRef).toBe("T1:C1");
    expect([opening.conversationId, separate.conversationId]).not.toContain(flat.conversationId);

    await expect(db.conversation.count({ where: { orgId: org.org.id } })).resolves.toBe(3);
    const stored = await db.conversation.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: opening.conversationId } },
    });
    expect(stored).toMatchObject({ surface: "slack", locationRef: "T1:C1", threadRef: "thread-1" });
    // A linked surface id records the person behind it; an unlinked one is
    // kept raw, so the thread still names who spoke.
    expect(stored.participants).toEqual([
      { principalId: member.principal.id, externalRef: "U-ASKS" },
      { principalId: null, externalRef: "U-AGENT" },
    ]);
    expect(stored.lastActivityAt.getTime()).toBeGreaterThan(stored.startedAt.getTime());

    const audit = await db.auditLog.findFirstOrThrow({
      where: { orgId: org.org.id, action: "session.messages", subject: opening.conversationId },
    });
    expect(audit.payload).toMatchObject({ sessionId: first.sessionId, created: 2 });
    // Ids and counts only: what was said never reaches the audit stream.
    expect(JSON.stringify(audit.payload)).not.toContain("kingfisher");
  });

  it("dedups by surface reference, edits in place, and deletes", async () => {
    const org = await createOrg();
    await bindChannel(org, "Incidents", "T1:C2");
    const session = await openSession(org, "T1:C2", "thread-1");

    const batch = [
      said("m-1", "The kingfisher deploy failed"),
      said("m-2", "Paging the release captain"),
    ];
    const first = await report(session, batch);
    expect(first).toMatchObject({ created: 2, unchanged: 0, messageCount: 2 });

    // Reporting the same batch again is a no-op, not a duplicate and not an
    // error: a harness that retries a request changes nothing.
    const again = await report(session, batch);
    expect(again).toMatchObject({
      conversationId: first.conversationId,
      created: 0,
      unchanged: 2,
      messageCount: 2,
    });
    expect(again.results.map(({ seq }) => seq)).toEqual([1, 2]);
    await expect(indexedMatches(org.org.id, "kingfisher")).resolves.toEqual([
      "The kingfisher deploy failed",
    ]);

    // An edit keeps the message's place in the thread and re-indexes its text.
    const edited = await report(session, [said("m-1", "The kingfisher deploy failed on staging")]);
    expect(edited).toMatchObject({ created: 0, updated: 1, messageCount: 2 });
    expect(edited.results[0]?.seq).toBe(1);
    await expect(indexedMatches(org.org.id, "staging")).resolves.toEqual([
      "The kingfisher deploy failed on staging",
    ]);

    // A deletion on the surface deletes the stored message and its index row.
    const deleted = await report(session, [
      { surfaceMessageRef: "m-1", operation: "delete" },
      { surfaceMessageRef: "m-404", operation: "delete" },
    ]);
    expect(deleted).toMatchObject({ deleted: 1, notFound: 1, messageCount: 1 });
    expect(deleted.results).toEqual([
      { surfaceMessageRef: "m-1", outcome: "deleted", seq: 1 },
      { surfaceMessageRef: "m-404", outcome: "not_found", seq: null },
    ]);
    await expect(indexedMatches(org.org.id, "kingfisher")).resolves.toEqual([]);
    await expect(
      db.message.count({ where: { orgId: org.org.id, conversationId: first.conversationId } }),
    ).resolves.toBe(1);

    // The numbering does not reuse a deleted message's place.
    const next = await report(session, [said("m-3", "Filed the incident review")]);
    expect(next.results[0]?.seq).toBe(3);
  });

  it("windows a transcript around a message and at the end of the thread", async () => {
    const org = await createOrg();
    await bindChannel(org, "Runbooks", "T1:C3");
    const session = await openSession(org, "T1:C3", "thread-1");
    const captured = await report(
      session,
      Array.from({ length: 30 }, (_, index) => said(`m-${index + 1}`, `Message ${index + 1}`)),
    );
    expect(captured.messageCount).toBe(30);

    const client = await connect(session.sessionToken);

    // No window asked for: the end of the thread, oldest first.
    const recent = await transcript(client, { conversationId: captured.conversationId });
    const tail = recent.structuredContent as unknown as Transcript;
    expect(recent.isError).toBeFalsy();
    expect(tail.messages).toHaveLength(20);
    expect(tail.messages.map(({ seq }) => seq)).toEqual(
      Array.from({ length: 20 }, (_, index) => index + 11),
    );
    expect(tail).toMatchObject({
      conversationId: captured.conversationId,
      messageCount: 30,
      firstSeq: 1,
      lastSeq: 30,
      hasMoreBefore: true,
      hasMoreAfter: false,
    });

    // A place in the thread reads with about half the window before it.
    const around = await transcript(client, {
      conversationId: captured.conversationId,
      aroundSeq: 15,
      window: 5,
    });
    const centred = around.structuredContent as unknown as Transcript;
    expect(centred.messages.map(({ seq }) => seq)).toEqual([13, 14, 15, 16, 17]);
    expect(centred).toMatchObject({ hasMoreBefore: true, hasMoreAfter: true });

    // A window that would start before the thread does starts at its first
    // message and fills forward.
    const start = await transcript(client, {
      conversationId: captured.conversationId,
      aroundSeq: 1,
      window: 4,
    });
    const opening = start.structuredContent as unknown as Transcript;
    expect(opening.messages.map(({ seq }) => seq)).toEqual([1, 2, 3, 4]);
    expect(opening).toMatchObject({ hasMoreBefore: false, hasMoreAfter: true });

    // The window is bounded by design: asking for the channel gets the cap.
    const capped = await transcript(client, {
      conversationId: captured.conversationId,
      window: FETCH_TRANSCRIPT_MAX_WINDOW,
    });
    expect((capped.structuredContent as unknown as Transcript).messages).toHaveLength(30);
    const refused = await transcript(client, {
      conversationId: captured.conversationId,
      window: FETCH_TRANSCRIPT_MAX_WINDOW + 1,
    });
    expect(refused.isError).toBe(true);
    expect(JSON.stringify(refused.content)).toContain("window");

    const audit = await db.auditLog.findFirstOrThrow({
      where: {
        orgId: org.org.id,
        action: "dataplane.fetch_transcript",
        subject: captured.conversationId,
      },
    });
    expect(audit.payload).toMatchObject({ sessionId: session.sessionId, returnedCount: 20 });
    expect(JSON.stringify(audit.payload)).not.toContain("Message 15");

    await client.close();
  });

  it("reads an empty conversation without inventing a window", async () => {
    const org = await createOrg();
    await bindChannel(org, "Quiet", "T1:C4");
    const session = await openSession(org, "T1:C4", "thread-1");
    const captured = await report(session, [said("m-1", "Only message")]);
    await report(session, [{ surfaceMessageRef: "m-1", operation: "delete" }]);

    const client = await connect(session.sessionToken);
    const read = await transcript(client, { conversationId: captured.conversationId });
    expect(read.isError).toBeFalsy();
    expect(read.structuredContent).toMatchObject({
      messageCount: 0,
      firstSeq: null,
      lastSeq: null,
      hasMoreBefore: false,
      hasMoreAfter: false,
      messages: [],
    });

    const missing = await transcript(client, { conversationId: randomUUID() });
    expect(missing.isError).toBe(true);
    expect(missing.content).toEqual([{ type: "text", text: "Conversation not found" }]);

    await client.close();
  });

  it("keeps a personal conversation out of every other session's reach", async () => {
    const org = await createOrg();
    const alice = await linkMember(org, "Alice", "U-ALICE");
    const bob = await linkMember(org, "Bob", "U-BOB");

    const aliceSession = await call(
      sessionsRouter.open,
      {
        surface: "slack",
        locationRef: "T1:D-ALICE",
        dm: true,
        requester: { externalUserId: "U-ALICE" },
      },
      { context: serviceContext(org.credential.secret) },
    );
    const personal = await report(aliceSession, [
      said("a-1", "My doctor's appointment moved to Thursday", "U-ALICE"),
    ]);
    const aliceScope = await db.scope.findFirstOrThrow({
      where: { orgId: org.org.id, kind: "personal", ownerId: alice.principal.id },
    });
    expect(personal.scopeId).toBe(aliceScope.id);

    // Alice's own session reads her own thread.
    const own = await connect(aliceSession.sessionToken);
    const mine = await transcript(own, { conversationId: personal.conversationId });
    expect(mine.isError).toBeFalsy();
    expect((mine.structuredContent as unknown as Transcript).messages).toHaveLength(1);
    await own.close();

    // Bob's personal session reads org plus his own scope, so Alice's thread
    // reports exactly like one that does not exist.
    const bobSession = await call(
      sessionsRouter.open,
      {
        surface: "slack",
        locationRef: "T1:D-BOB",
        dm: true,
        requester: { externalUserId: "U-BOB" },
      },
      { context: serviceContext(org.credential.secret) },
    );
    expect(bobSession.actingPrincipalId).toBe(bob.principal.id);
    const bobClient = await connect(bobSession.sessionToken);
    const denied = await transcript(bobClient, { conversationId: personal.conversationId });
    const unknown = await transcript(bobClient, { conversationId: randomUUID() });
    expect(denied.isError).toBe(true);
    expect(denied.content).toEqual(unknown.content);
    await bobClient.close();

    // A shared-scope session cannot reach a personal conversation either.
    await bindChannel(org, "Shared", "T1:C5");
    const shared = await openSession(org, "T1:C5", "thread-1");
    const sharedClient = await connect(shared.sessionToken);
    const refused = await transcript(sharedClient, { conversationId: personal.conversationId });
    expect(refused.isError).toBe(true);
    expect(refused.content).toEqual(unknown.content);
    await sharedClient.close();

    // Nothing was read, so nothing was audited as read.
    await expect(
      db.auditLog.count({ where: { orgId: org.org.id, action: "dataplane.fetch_transcript" } }),
    ).resolves.toBe(1);
  });

  it("numbers racing batches on one thread without a gap or a repeat", async () => {
    const org = await createOrg();
    await bindChannel(org, "Busy", "T1:C6");
    const first = await openSession(org, "T1:C6", "thread-1");
    const second = await openSession(org, "T1:C6", "thread-1");
    const opening = await report(first, [said("m-0", "Opening the thread")]);

    const [left, right] = await Promise.all([
      report(first, [said("a-1", "Left one"), said("a-2", "Left two")]),
      report(second, [said("b-1", "Right one"), said("b-2", "Right two")]),
    ]);
    expect(left.conversationId).toBe(opening.conversationId);
    expect(right.conversationId).toBe(opening.conversationId);

    const stored = await db.message.findMany({
      where: { orgId: org.org.id, conversationId: opening.conversationId },
      orderBy: { seq: "asc" },
    });
    expect(stored.map(({ seq }) => seq)).toEqual([1, 2, 3, 4, 5]);
    expect(new Set(stored.map(({ surfaceMessageRef }) => surfaceMessageRef)).size).toBe(5);
    expect(left.messageCount === 5 || right.messageCount === 5).toBe(true);
  });

  it("refuses a mismatched, closed, or expired session", async () => {
    const org = await createOrg();
    await bindChannel(org, "Lifetime", "T1:C7");
    const session = await openSession(org, "T1:C7", "thread-1");
    const other = await openSession(org, "T1:C7", "thread-2");

    // The path id and the token must name the same session.
    await expect(
      call(
        sessionsRouter.messages,
        { id: other.sessionId, messages: [said("m-1", "Wrong session")] },
        { context: sessionContext(session.sessionToken) },
      ),
    ).rejects.toThrow(/Session not found/);

    // A message needs an author and something said.
    await expect(
      report(session, [
        { surfaceMessageRef: "m-1", text: "No author", sentAt: new Date().toISOString() },
      ]),
    ).rejects.toThrow(/author/);

    await db.contextSession.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() - 1_000) },
    });
    await expect(report(session, [said("m-2", "Too late")])).rejects.toThrow(/expired/);

    await db.contextSession.update({
      where: { id: session.sessionId },
      data: { expiresAt: new Date(Date.now() + 60_000), closedAt: new Date() },
    });
    await expect(report(session, [said("m-3", "Already closed")])).rejects.toThrow(/closed/);

    await expect(db.message.count({ where: { orgId: org.org.id } })).resolves.toBe(0);
  });
});
