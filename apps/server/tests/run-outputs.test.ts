import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Principal, Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { orgRouter } from "#server/rpc/org.js";
import { runsRouter } from "#server/rpc/runs.js";
import {
  TOOL_OUTPUT_IMAGE_BYTE_CAP,
  TOOL_OUTPUT_TEXT_BYTE_CAP,
} from "#server/services/runs/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("run output resolution", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "run-output-integration-secret-at-least-32-chars",
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
    const signedUp = await signUp("Run Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Run Org" },
      { context: signedUp.context },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "agent" },
    });
    return { ...signedUp, ...membership, orgScope, agent };
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

  async function openSession(orgId: string, scopeId: string, agent: Principal) {
    return db.contextSession.create({
      data: {
        orgId,
        scopeId,
        surface: "web",
        locationRef: "member-1",
        mode: "service",
        scopeChain: [scopeId],
        actingPrincipalId: agent.id,
        standing: { instructions: "Be useful.", rules: [], skillIndex: [] },
        policySnapshot: {},
        snapshotHash: "snapshot-hash-1",
        tokenHash: randomUUID(),
        expiresAt: new Date(Date.now() + 3_600_000),
      },
    });
  }

  async function createRun(orgId: string, sessionId: string) {
    return db.agentRun.create({
      data: {
        id: `run-${randomUUID()}`,
        orgId,
        threadRef: "web:alice",
        state: "completed",
        trigger: "message",
        sessionId,
      },
    });
  }

  /** Commits one turn holding the given tool-result messages. */
  async function appendTurn(orgId: string, runId: string, index: number, toolResults: unknown) {
    await db.turn.create({
      data: {
        orgId,
        runId,
        index,
        model: { id: "test/model" } as object,
        message: { role: "assistant", blocks: [] } as object,
        toolResults: toolResults as object,
        stopReason: "toolUse",
        usage: {} as object,
      },
    });
  }

  async function appendEvents(orgId: string, runId: string, events: unknown[]) {
    let seq = 0;
    for (const event of events) {
      seq += 1;
      await db.runEvent.create({
        data: { orgId, runId, seq, at: new Date(), event: event as object },
      });
    }
    await db.agentRun.update({
      where: { orgId_id: { orgId, id: runId } },
      data: { lastEventSeq: seq },
    });
  }

  function toolResult(callId: string, blocks: unknown[], status = "ok") {
    return { role: "toolResult", toolCallId: callId, blocks, status };
  }

  /** An org with Alice owning a personal-scope run, plus fellow member Bob. */
  async function setup() {
    const org = await createOrg();
    const alice = await addMember(org.org.id, org.orgScope.id, "member", "Alice");
    const bob = await addMember(org.org.id, org.orgScope.id, "member", "Bob");
    const scope = await personalScope(org.org.id, alice.principal);
    const session = await openSession(org.org.id, scope.id, org.agent);
    const run = await createRun(org.org.id, session.id);
    return { org, alice, bob, scope, session, run };
  }

  it("resolves a text output with its content, status, and event summary", async () => {
    const { org, alice, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [{ type: "text", text: '{"rows": [1, 2, 3]}' }]),
    ]);
    await appendEvents(org.org.id, run.id, [
      { type: "run-started", trigger: "message" },
      { type: "tool-start", callId: "call-1", name: "lookup", title: "Lookup", kind: "search" },
      { type: "tool-result", callId: "call-1", status: "ok", summary: "3 rows", outputRef: "call-1" },
    ]);

    const output = await call(
      runsRouter.output,
      { id: run.id, outputRef: "call-1" },
      { context: alice.context },
    );

    expect(output).toEqual({
      callId: "call-1",
      status: "ok",
      summary: "3 rows",
      blocks: [{ kind: "text", text: '{"rows": [1, 2, 3]}', truncated: false }],
    });
  });

  it("resolves an output whose event never carried a ref", async () => {
    // Runs recorded before refs were minted still resolve: resolution reads
    // the transcript, not the event.
    const { org, alice, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-old", [{ type: "text", text: "historical body" }], "error"),
    ]);
    await appendEvents(org.org.id, run.id, [
      { type: "tool-result", callId: "call-old", status: "error", summary: "it failed" },
    ]);

    const output = await call(
      runsRouter.output,
      { id: run.id, outputRef: "call-old" },
      { context: alice.context },
    );

    expect(output).toEqual({
      callId: "call-old",
      status: "error",
      summary: "it failed",
      blocks: [{ kind: "text", text: "historical body", truncated: false }],
    });
  });

  it("finds the call across turns and returns a null summary without an event", async () => {
    const { org, alice, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [{ type: "text", text: "first turn" }]),
    ]);
    await appendTurn(org.org.id, run.id, 1, [
      toolResult("call-2", [{ type: "text", text: "second turn" }]),
    ]);

    const output = await call(
      runsRouter.output,
      { id: run.id, outputRef: "call-2" },
      { context: alice.context },
    );

    expect(output).toEqual({
      callId: "call-2",
      status: "ok",
      summary: null,
      blocks: [{ kind: "text", text: "second turn", truncated: false }],
    });
  });

  it("cuts oversized text at the byte cap and declares the cut", async () => {
    const { org, alice, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [{ type: "text", text: "x".repeat(TOOL_OUTPUT_TEXT_BYTE_CAP + 100) }]),
    ]);

    const output = await call(
      runsRouter.output,
      { id: run.id, outputRef: "call-1" },
      { context: alice.context },
    );

    expect(output.blocks).toEqual([
      { kind: "text", text: "x".repeat(TOOL_OUTPUT_TEXT_BYTE_CAP), truncated: true },
    ]);
  });

  it("round-trips an image under the cap and omits one over it, honestly", async () => {
    const { org, alice, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [
        { type: "image", mediaType: "image/png", data: "aGVsbG8=" },
        { type: "image", mediaType: "image/jpeg", data: "A".repeat(TOOL_OUTPUT_IMAGE_BYTE_CAP + 1) },
        { type: "text", text: "two screenshots" },
      ]),
    ]);

    const output = await call(
      runsRouter.output,
      { id: run.id, outputRef: "call-1" },
      { context: alice.context },
    );

    expect(output.blocks).toEqual([
      { kind: "image", mediaType: "image/png", data: "aGVsbG8=", omitted: false },
      { kind: "image", mediaType: "image/jpeg", data: null, omitted: true },
      { kind: "text", text: "two screenshots", truncated: false },
    ]);
  });

  it("answers an unknown ref exactly like a missing run", async () => {
    const { alice, org, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [{ type: "text", text: "body" }]),
    ]);

    await expect(
      call(
        runsRouter.output,
        { id: run.id, outputRef: "call-unknown" },
        { context: alice.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
    await expect(
      call(
        runsRouter.output,
        { id: "run-missing", outputRef: "call-1" },
        { context: alice.context },
      ),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
  });

  it("hides another member's personal-scope output like a missing run", async () => {
    const { org, bob, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [{ type: "text", text: "private body" }]),
    ]);

    await expect(
      call(runsRouter.output, { id: run.id, outputRef: "call-1" }, { context: bob.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
  });

  it("refuses the audit view the content: metadata access reads nothing", async () => {
    // The org owner gets audit metadata on Alice's run, but outputs are
    // content — the refusal is the same NOT_FOUND as a missing run.
    const { org, run } = await setup();
    await appendTurn(org.org.id, run.id, 0, [
      toolResult("call-1", [{ type: "text", text: "private body" }]),
    ]);

    await expect(
      call(runsRouter.output, { id: run.id, outputRef: "call-1" }, { context: org.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND", message: "Run not found" });
  });
});
