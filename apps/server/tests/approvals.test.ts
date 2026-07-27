import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { Prisma, type Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { approvalsRouter } from "#server/rpc/approvals.js";
import { bindingsRouter } from "#server/rpc/bindings.js";
import { serviceCredentialsRouter } from "#server/rpc/credentials.js";
import { itemsRouter } from "#server/rpc/items.js";
import { orgRouter } from "#server/rpc/org.js";
import { policiesRouter } from "#server/rpc/policies.js";
import { scopesRouter } from "#server/rpc/scopes.js";
import { sessionsRouter } from "#server/rpc/sessions.js";
import {
  ACTIVATE_ITEM_TOOL_KEY,
  ApprovalArgsMismatchError,
  ApprovalStateError,
  claimApprovalExecution,
  requestApproval,
  requestItemActivation,
  sweepApprovals,
} from "#server/services/approvals/index.js";
import { createItem, transitionItem } from "#server/services/items/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const HOUR_MS = 60 * 60 * 1000;

integration("approvals", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "approval-integration-secret-at-least-32-characters",
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
    const signedUp = await signUp("Approval Owner");
    const membership = await call(
      orgRouter.create,
      { name: "Approval Org" },
      { context: signedUp.context },
    );
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "agent" },
    });
    const credential = await call(
      serviceCredentialsRouter.create,
      { name: "Harness" },
      { context: signedUp.context },
    );
    return { ...signedUp, ...membership, orgScope, agent, credential };
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

  function serviceContext(secret: string) {
    return { db, auth, env, headers: new Headers({ authorization: `Bearer ${secret}` }) };
  }

  /** A shared scope bound to a location, with an open session against it. */
  async function openSharedSession(
    org: Awaited<ReturnType<typeof createOrg>>,
    options: { name: string; requesterPrincipalId?: string },
  ) {
    const scope = await call(scopesRouter.create, { name: options.name }, { context: org.context });
    const locationRef = `T1:${randomUUID()}`;
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef, scopeId: scope.id },
      { context: org.context },
    );
    const session = await call(
      sessionsRouter.open,
      {
        surface: "slack",
        locationRef,
        ...(options.requesterPrincipalId
          ? { requester: { principalId: options.requesterPrincipalId } }
          : {}),
      },
      { context: serviceContext(org.credential.secret) },
    );
    return { scope, session };
  }

  it("covers the recorded arguments alone, and refuses a changed call", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Asker");
    const opened = await openSharedSession(org, {
      name: "Delivery",
      requesterPrincipalId: member.principal.id,
    });

    const args = { repo: "trema", branch: "main", force: true };
    const requested = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args,
      reason: "Removing the merged release branch",
    });
    expect(requested.outcome).toBe("approval_required");
    if (requested.outcome !== "approval_required") throw new Error("unreachable");
    // The arguments are stored verbatim, not just fingerprinted.
    expect(requested.approval.argsJson).toEqual(args);

    await call(approvalsRouter.approve, { id: requested.approval.id }, { context: org.context });

    await expect(
      claimApprovalExecution(db, {
        orgId: org.org.id,
        approvalId: requested.approval.id,
        args: { ...args, branch: "release" },
      }),
    ).rejects.toBeInstanceOf(ApprovalArgsMismatchError);
    // An executor that says nothing about the call it is running is refused too:
    // the comparison is the binding, so there is no way to skip it.
    await expect(
      claimApprovalExecution(db, {
        orgId: org.org.id,
        approvalId: requested.approval.id,
        args: undefined,
      }),
    ).rejects.toBeInstanceOf(ApprovalArgsMismatchError);
    // The refusal changes nothing: the approval is still there to execute.
    await expect(
      db.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: requested.approval.id } },
        select: { executedAt: true },
      }),
    ).resolves.toMatchObject({ executedAt: null });

    // Key order is not part of the call, so the same call in another order runs.
    const claimed = await claimApprovalExecution(db, {
      orgId: org.org.id,
      approvalId: requested.approval.id,
      args: { force: true, branch: "main", repo: "trema" },
    });
    expect(claimed.executedAt).not.toBeNull();
  });

  it("lets exactly one of many concurrent executors run the call", async () => {
    const org = await createOrg();
    const opened = await openSharedSession(org, { name: "Racing" });
    const requested = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema" },
      reason: "Cleaning up",
    });
    if (requested.outcome !== "approval_required") throw new Error("unreachable");
    await call(approvalsRouter.approve, { id: requested.approval.id }, { context: org.context });

    const attempts = await Promise.allSettled(
      Array.from({ length: 6 }, () =>
        claimApprovalExecution(db, {
          orgId: org.org.id,
          approvalId: requested.approval.id,
          args: { repo: "trema" },
        }),
      ),
    );
    const won = attempts.filter((attempt) => attempt.status === "fulfilled");
    expect(won).toHaveLength(1);
    for (const lost of attempts.filter((attempt) => attempt.status === "rejected")) {
      expect((lost as PromiseRejectedResult).reason).toBeInstanceOf(ApprovalStateError);
      expect((lost as PromiseRejectedResult).reason.code).toBe("already_executed");
    }
  });

  it("resolves an approval once, whichever approver gets there first", async () => {
    const org = await createOrg();
    const first = await addMember(org.org.id, org.orgScope.id, "admin", "First Admin");
    const second = await addMember(org.org.id, org.orgScope.id, "admin", "Second Admin");
    const opened = await openSharedSession(org, { name: "Two Admins" });
    const requested = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema" },
      reason: "Cleaning up",
    });
    if (requested.outcome !== "approval_required") throw new Error("unreachable");

    const attempts = await Promise.allSettled([
      call(approvalsRouter.approve, { id: requested.approval.id }, { context: first.context }),
      call(approvalsRouter.deny, { id: requested.approval.id }, { context: second.context }),
    ]);
    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const loser = attempts.find((attempt) => attempt.status === "rejected");
    expect((loser as PromiseRejectedResult).reason).toMatchObject({ code: "CONFLICT" });
  });

  it("validates approvers against the rule pinned at open, not the policy now", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Asker");
    const opened = await openSharedSession(org, {
      name: "Pinned",
      requesterPrincipalId: member.principal.id,
    });
    await call(
      policiesRouter.set,
      {
        scopeId: opened.scope.id,
        sensitivity: "destructive",
        action: "require_approval",
        approverRoles: ["owner"],
      },
      { context: org.context },
    );

    // The session pinned the defaults, which name owner and admin. The row
    // written after it opened reaches the next session, never this one.
    const requested = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema" },
      reason: "Cleaning up",
    });
    if (requested.outcome !== "approval_required") throw new Error("unreachable");
    expect(requested.approval.approverRoles).toEqual(["owner", "admin"]);

    const admin = await addMember(org.org.id, org.orgScope.id, "admin", "Admin");
    const listedForAdmin = await call(approvalsRouter.list, {}, { context: admin.context });
    expect(listedForAdmin.approvals.map(({ id }) => id)).toEqual([requested.approval.id]);
    // A member holds no approver role, so the approval is not theirs to resolve.
    const listedForMember = await call(approvalsRouter.list, {}, { context: member.context });
    expect(listedForMember.approvals).toHaveLength(0);
    await expect(
      call(approvalsRouter.approve, { id: requested.approval.id }, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const approved = await call(
      approvalsRouter.approve,
      { id: requested.approval.id },
      { context: admin.context },
    );
    expect(approved.approval).toMatchObject({
      status: "approved",
      resolvedById: admin.principal.id,
    });
  });

  it("keeps the requester out of a destructive decision and lets them into a write", async () => {
    const org = await createOrg();
    const admin = await addMember(org.org.id, org.orgScope.id, "admin", "Asking Admin");
    const opened = await openSharedSession(org, {
      name: "Separation",
      requesterPrincipalId: admin.principal.id,
    });

    // The destructive default keeps the person who asked out of it, however
    // senior they are.
    const destructive = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_repo",
      sensitivity: "destructive",
      args: { repo: "trema" },
      reason: "Retiring the repository",
    });
    if (destructive.outcome !== "approval_required") throw new Error("unreachable");
    expect(destructive.approval.allowRequesterApproval).toBe(false);
    await expect(
      call(approvalsRouter.approve, { id: destructive.approval.id }, { context: admin.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await call(approvalsRouter.approve, { id: destructive.approval.id }, { context: org.context });

    // The write default treats the ask as the approval, so the same person may
    // wave their own write through.
    const write = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:open_issue",
      sensitivity: "write",
      args: { title: "Retire the repository" },
      reason: "Filing the follow-up",
    });
    if (write.outcome !== "approval_required") throw new Error("unreachable");
    const approved = await call(
      approvalsRouter.approve,
      { id: write.approval.id },
      { context: admin.context },
    );
    expect(approved.approval.status).toBe("approved");
  });

  it("keeps a personal scope's confirm step with its owner", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Dm Human");
    await db.identityLink.create({
      data: {
        orgId: org.org.id,
        surface: "slack",
        externalUserId: "U-DM",
        principalId: member.principal.id,
      },
    });
    const session = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:D1", dm: true, requester: { externalUserId: "U-DM" } },
      { context: serviceContext(org.credential.secret) },
    );
    const personalScopeId = session.scopeChain.at(-1)?.id ?? "";

    const proposed = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: personalScopeId,
      kind: "memory",
      title: "Draft replies in the morning",
      body: { type: "rule", content: "Draft replies before 10:00 and send them after review." },
      writerKind: "agent",
      sourceSessionId: session.sessionId,
    });
    const approval = await requestItemActivation(db, {
      orgId: org.org.id,
      sessionId: session.sessionId,
      itemId: proposed.id,
      reason: "This is how the mornings have gone all month",
    });
    // The personal defaults make the confirm step the owner's own: no role
    // list, and the person who asked is the one who says yes.
    expect(approval).toMatchObject({ approverRoles: [], allowRequesterApproval: true });

    // The organization's owner does not reach into someone's personal scope.
    await expect(
      call(approvalsRouter.approve, { id: approval.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });

    const resolved = await call(
      approvalsRouter.approve,
      { id: approval.id },
      { context: member.context },
    );
    expect(resolved.activatedItemId).toBe(proposed.id);
    const activated = await db.item.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: proposed.id } },
    });
    expect(activated).toMatchObject({ status: "active", confirmedById: member.principal.id });
  });

  it("expires visibly, re-nudges on a schedule, and does neither twice", async () => {
    const org = await createOrg();
    const opened = await openSharedSession(org, { name: "Waiting" });
    const waiting = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema", branch: "old" },
      reason: "Cleaning up",
    });
    const shortLived = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema", branch: "older" },
      reason: "Cleaning up",
      ttlMs: HOUR_MS,
    });
    if (waiting.outcome !== "approval_required") throw new Error("unreachable");
    if (shortLived.outcome !== "approval_required") throw new Error("unreachable");

    const twoHoursOn = new Date(Date.now() + 2 * HOUR_MS);
    const first = await sweepApprovals(db, { orgId: org.org.id, now: twoHoursOn });
    expect(first).toEqual({ expired: 1, nudged: 1 });

    // A duplicate firing converges: nothing expires twice, nothing is nudged
    // twice inside one interval.
    const second = await sweepApprovals(db, { orgId: org.org.id, now: twoHoursOn });
    expect(second).toEqual({ expired: 0, nudged: 0 });

    const expired = await db.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: shortLived.approval.id } },
    });
    expect(expired.status).toBe("expired");
    const stillPending = await db.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: waiting.approval.id } },
    });
    expect(stillPending).toMatchObject({ status: "pending", nudgeCount: 1 });

    // Expiry is a recorded fact, and a decision arriving afterwards is refused.
    const audited = await db.auditLog.findFirst({
      where: { orgId: org.org.id, action: "approval.expired", subject: shortLived.approval.id },
    });
    expect(audited).not.toBeNull();
    await expect(
      call(approvalsRouter.approve, { id: shortLived.approval.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    // The next interval nudges again.
    const third = await sweepApprovals(db, {
      orgId: org.org.id,
      now: new Date(Date.now() + 4 * HOUR_MS),
    });
    expect(third.nudged).toBe(1);
  });

  it("activates a proposed item through the approval machinery, and only through it", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Asker");
    const opened = await openSharedSession(org, {
      name: "Standing",
      requesterPrincipalId: member.principal.id,
    });

    // A rule the agent wrote lands proposed, per the write policy.
    const proposed = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: opened.scope.id,
      kind: "memory",
      title: "Escalate refunds over $500",
      body: { type: "rule", content: "Escalate any refund over $500 to finance." },
      writerKind: "agent",
      sourceSessionId: opened.session.sessionId,
    });
    expect(proposed.status).toBe("proposed");

    // The run cannot turn its own proposal on.
    await expect(
      transitionItem(db, {
        orgId: org.org.id,
        actorPrincipalId: org.agent.id,
        itemId: proposed.id,
        action: "activate",
      }),
    ).rejects.toMatchObject({ name: "ItemValidationError" });

    const approval = await requestItemActivation(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      itemId: proposed.id,
      reason: "This rule came up twice this week",
    });
    expect(approval).toMatchObject({
      toolKey: ACTIVATE_ITEM_TOOL_KEY,
      sensitivity: "write",
      status: "pending",
    });
    expect(approval.argsJson).toEqual({ itemId: proposed.id });

    // Asking again while the first ask waits is one decision, not two.
    const again = await requestItemActivation(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      itemId: proposed.id,
      reason: "This rule came up twice this week",
    });
    expect(again.id).toBe(approval.id);

    const resolved = await call(
      approvalsRouter.approve,
      { id: approval.id },
      { context: org.context },
    );
    expect(resolved.activatedItemId).toBe(proposed.id);
    expect(resolved.approval.executedAt).not.toBeNull();

    const item = await call(itemsRouter.get, { id: proposed.id }, { context: org.context });
    expect(item).toMatchObject({ status: "active", confirmedById: org.principal.id });

    // The decision is single-shot, so a second click cannot re-run it.
    await expect(
      call(approvalsRouter.approve, { id: approval.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("records one pending approval however many asks arrive at once", async () => {
    const org = await createOrg();
    const opened = await openSharedSession(org, { name: "Concurrent Asks" });

    const ask = () =>
      requestApproval(db, {
        orgId: org.org.id,
        sessionId: opened.session.sessionId,
        toolKey: "github:delete_branch",
        sensitivity: "destructive",
        args: { repo: "trema", branch: "main" },
        reason: "Cleaning up",
      });

    // A resumed run repeating its tool call is one decision for a person, and
    // two runs racing to ask must not become two.
    const asked = await Promise.all(Array.from({ length: 5 }, ask));
    const ids = new Set(
      asked.map((outcome) =>
        outcome.outcome === "approval_required" ? outcome.approval.id : "not-required",
      ),
    );
    expect(ids.size).toBe(1);
    expect(await db.approval.count({ where: { orgId: org.org.id } })).toBe(1);
  });

  it("asks again once a stale pending ask is past its deadline", async () => {
    const org = await createOrg();
    const opened = await openSharedSession(org, { name: "Stale Ask" });
    const sameCall = {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive" as const,
      args: { repo: "trema", branch: "main" },
      reason: "Cleaning up",
    };

    const first = await requestApproval(db, { ...sameCall, ttlMs: HOUR_MS });
    if (first.outcome !== "approval_required") throw new Error("unreachable");

    // Nothing has swept the expired ask yet. The new ask is a new decision, and
    // the stale one is recorded as expired rather than quietly reused.
    const second = await requestApproval(db, {
      ...sameCall,
      now: new Date(Date.now() + 2 * HOUR_MS),
    });
    if (second.outcome !== "approval_required") throw new Error("unreachable");
    expect(second.approval.id).not.toBe(first.approval.id);
    await expect(
      db.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: first.approval.id } },
        select: { status: true },
      }),
    ).resolves.toMatchObject({ status: "expired" });
  });

  it("fills the listing limit from behind approvals that are not the caller's", async () => {
    const org = await createOrg();
    const admin = await addMember(org.org.id, org.orgScope.id, "admin", "Queue Admin");
    // The admin asked for these, and a destructive call keeps the asker out of
    // its own decision — so none of them belong in the admin's queue.
    const theirs = await openSharedSession(org, {
      name: "Own Asks",
      requesterPrincipalId: admin.principal.id,
    });
    for (let index = 0; index < 6; index += 1) {
      await requestApproval(db, {
        orgId: org.org.id,
        sessionId: theirs.session.sessionId,
        toolKey: "github:delete_branch",
        sensitivity: "destructive",
        args: { repo: "trema", branch: `own-${index}` },
        reason: "Cleaning up",
      });
    }

    const member = await addMember(org.org.id, org.orgScope.id, "member", "Someone Else");
    const others = await openSharedSession(org, {
      name: "Other Asks",
      requesterPrincipalId: member.principal.id,
    });
    const resolvable: string[] = [];
    for (let index = 0; index < 3; index += 1) {
      const requested = await requestApproval(db, {
        orgId: org.org.id,
        sessionId: others.session.sessionId,
        toolKey: "github:delete_branch",
        sensitivity: "destructive",
        args: { repo: "trema", branch: `other-${index}` },
        reason: "Cleaning up",
      });
      if (requested.outcome !== "approval_required") throw new Error("unreachable");
      resolvable.push(requested.approval.id);
    }

    // The oldest six rows are not the admin's to resolve. A limit of two is two
    // approvals they can act on, not two rows read and none returned.
    const listed = await call(approvalsRouter.list, { limit: 2 }, { context: admin.context });
    expect(listed.approvals.map(({ id }) => id)).toEqual(resolvable.slice(0, 2));
    const all = await call(approvalsRouter.list, {}, { context: admin.context });
    expect(all.approvals.map(({ id }) => id)).toEqual(resolvable);
  });

  it("keeps an overdue ask out of the queue before any sweep records the expiry", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Asker");
    const opened = await openSharedSession(org, {
      name: "Overdue",
      requesterPrincipalId: member.principal.id,
    });

    // Recorded an hour ago with a minute to live: past its deadline, but still
    // `pending` because no sweep and no resolve attempt has touched it.
    const overdue = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema", branch: "stale" },
      reason: "Cleaning up",
      ttlMs: 60_000,
      now: new Date(Date.now() - HOUR_MS),
    });
    const live = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:delete_branch",
      sensitivity: "destructive",
      args: { repo: "trema", branch: "fresh" },
      reason: "Cleaning up",
    });
    if (overdue.outcome !== "approval_required" || live.outcome !== "approval_required") {
      throw new Error("unreachable");
    }

    // The queue promises what the approve call would accept, and approve would
    // refuse the overdue ask as expired — so the listing never surfaces it.
    const queue = await call(approvalsRouter.list, {}, { context: org.context });
    expect(queue.approvals.map(({ id }) => id)).toEqual([live.approval.id]);
    // Filtered, not expired: recording the expiry stays the sweep's job.
    await expect(
      db.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: overdue.approval.id } },
        select: { status: true },
      }),
    ).resolves.toEqual({ status: "pending" });
  });

  it("treats activating from the control plane as the approval itself", async () => {
    const org = await createOrg();
    const asker = await addMember(org.org.id, org.orgScope.id, "member", "Asker");
    const bystander = await addMember(org.org.id, org.orgScope.id, "member", "Bystander");
    const admin = await addMember(org.org.id, org.orgScope.id, "admin", "Confirming Admin");
    const opened = await openSharedSession(org, {
      name: "Control Plane",
      requesterPrincipalId: asker.principal.id,
    });

    async function propose(title: string) {
      return createItem(db, {
        orgId: org.org.id,
        actorPrincipalId: org.agent.id,
        scopeId: opened.scope.id,
        kind: "memory",
        title,
        body: { type: "rule", content: `${title}: always.` },
        writerKind: "agent",
        sourceSessionId: opened.session.sessionId,
      });
    }

    const asked = await propose("Escalate refunds over $500");
    const approval = await requestItemActivation(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      itemId: asked.id,
      reason: "This rule came up twice this week",
    });

    // A member holds write_items, so the route is reachable — and refuses,
    // because the decision is the approval's and they cannot resolve it.
    await expect(
      call(itemsRouter.activate, { id: asked.id }, { context: bystander.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      db.item.findUniqueOrThrow({ where: { orgId_id: { orgId: org.org.id, id: asked.id } } }),
    ).resolves.toMatchObject({ status: "proposed", confirmedById: null });
    await expect(
      db.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: approval.id } },
        select: { status: true },
      }),
    ).resolves.toMatchObject({ status: "pending" });

    // An approver confirming from the control plane resolves the waiting
    // approval rather than leaving it behind: one item, one decision.
    const activated = await call(
      itemsRouter.activate,
      { id: asked.id },
      { context: admin.context },
    );
    expect(activated).toMatchObject({ status: "active", confirmedById: admin.principal.id });
    const resolvedApproval = await db.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: approval.id } },
    });
    expect(resolvedApproval).toMatchObject({
      status: "approved",
      resolvedById: admin.principal.id,
    });
    expect(resolvedApproval.executedAt).not.toBeNull();

    // Nothing asked for this one, so the scope's policy as it stands decides.
    const unasked = await propose("Escalate chargebacks");
    await expect(
      call(itemsRouter.activate, { id: unasked.id }, { context: bystander.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(itemsRouter.activate, { id: unasked.id }, { context: admin.context }),
    ).resolves.toMatchObject({ status: "active", confirmedById: admin.principal.id });
    // Confirming without an approval creates none: the audit entry is the
    // item's own activation.
    expect(await db.approval.count({ where: { orgId: org.org.id } })).toBe(1);

    // Archiving and restoring are ordinary lifecycle edits, and write_items
    // still governs them alone.
    await expect(
      call(itemsRouter.archive, { id: unasked.id }, { context: bystander.context }),
    ).resolves.toMatchObject({ status: "archived" });
    await expect(
      call(itemsRouter.restore, { id: unasked.id }, { context: bystander.context }),
    ).resolves.toMatchObject({ status: "active" });
  });

  it("lets the person a proposal was made for confirm it in their own scope", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member", "Dm Owner");
    await db.identityLink.create({
      data: {
        orgId: org.org.id,
        surface: "slack",
        externalUserId: "U-OWN",
        principalId: member.principal.id,
      },
    });
    const session = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef: "T1:D2", dm: true, requester: { externalUserId: "U-OWN" } },
      { context: serviceContext(org.credential.secret) },
    );
    const personalScopeId = session.scopeChain.at(-1)?.id ?? "";
    const proposed = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: personalScopeId,
      kind: "memory",
      title: "Draft replies in the morning",
      body: { type: "rule", content: "Draft replies before 10:00." },
      writerKind: "agent",
      sourceSessionId: session.sessionId,
    });

    // The personal defaults make the confirm step the owner's own, and nobody
    // asked, so the control-plane route is where it happens.
    await expect(
      call(itemsRouter.activate, { id: proposed.id }, { context: member.context }),
    ).resolves.toMatchObject({ status: "active", confirmedById: member.principal.id });
  });

  it("retires every other ask about an item once it is on", async () => {
    const org = await createOrg();
    const scope = await call(
      scopesRouter.create,
      { name: "Twice Asked" },
      { context: org.context },
    );
    const locationRef = `T1:${randomUUID()}`;
    await call(
      bindingsRouter.create,
      { surface: "slack", locationRef, scopeId: scope.id },
      { context: org.context },
    );

    // Two runs against the same scope: the re-ask dedup is per session, so each
    // one legitimately holds its own pending ask about the same item.
    const first = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef },
      { context: serviceContext(org.credential.secret) },
    );
    const second = await call(
      sessionsRouter.open,
      { surface: "slack", locationRef },
      { context: serviceContext(org.credential.secret) },
    );
    const proposed = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: scope.id,
      kind: "memory",
      title: "Escalate refunds over $500",
      body: { type: "rule", content: "Escalate any refund over $500 to finance." },
      writerKind: "agent",
      sourceSessionId: first.sessionId,
    });
    const asks = [];
    for (const sessionId of [first.sessionId, second.sessionId]) {
      asks.push(
        await requestItemActivation(db, {
          orgId: org.org.id,
          sessionId,
          itemId: proposed.id,
          reason: "This rule came up twice this week",
        }),
      );
    }
    expect(new Set(asks.map(({ id }) => id)).size).toBe(2);

    const resolved = await call(
      approvalsRouter.approve,
      { id: asks[0]?.id ?? "" },
      { context: org.context },
    );
    expect(resolved.activatedItemId).toBe(proposed.id);

    // The item is on, so the other ask is a question nobody needs answered. It
    // ends visibly rather than sitting in a queue being nudged.
    const other = await db.approval.findUniqueOrThrow({
      where: { orgId_id: { orgId: org.org.id, id: asks[1]?.id ?? "" } },
    });
    expect(other.status).toBe("expired");
    expect(
      await db.auditLog.findFirst({
        where: { orgId: org.org.id, action: "approval.superseded", subject: other.id },
      }),
    ).not.toBeNull();
    expect(await sweepApprovals(db, { orgId: org.org.id })).toEqual({ expired: 0, nudged: 0 });
    const queue = await call(approvalsRouter.list, {}, { context: org.context });
    expect(queue.approvals).toHaveLength(0);
  });

  it("refuses an activation that names no item while it is still pending", async () => {
    const org = await createOrg();
    const opened = await openSharedSession(org, { name: "Malformed" });
    const approval = await db.approval.create({
      data: {
        orgId: org.org.id,
        sessionId: opened.session.sessionId,
        scopeId: opened.scope.id,
        toolKey: ACTIVATE_ITEM_TOOL_KEY,
        argsJson: Prisma.JsonNull,
        argsHash: "0".repeat(64),
        reason: "Recorded without an item",
        sensitivity: "write",
        approverRoles: ["owner", "admin"],
        allowRequesterApproval: false,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });

    await expect(
      call(approvalsRouter.approve, { id: approval.id }, { context: org.context }),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    // The refusal writes nothing: the claim is the right to run the call once
    // and this call never ran, and the decision is not recorded either — an
    // approval stuck `approved` and unexecutable could never be resolved again.
    await expect(
      db.approval.findUniqueOrThrow({
        where: { orgId_id: { orgId: org.org.id, id: approval.id } },
        select: { status: true, executedAt: true, resolvedById: true },
      }),
    ).resolves.toMatchObject({ status: "pending", executedAt: null, resolvedById: null });

    // Still pending means still answerable: it can be denied, and it expires
    // like anything else nobody answers.
    const denied = await call(approvalsRouter.deny, { id: approval.id }, { context: org.context });
    expect(denied.status).toBe("denied");
  });

  it("skips the approval entirely where the policy allows the class", async () => {
    const org = await createOrg();
    const opened = await openSharedSession(org, { name: "Open Season" });
    await call(
      policiesRouter.set,
      { scopeId: opened.scope.id, sensitivity: "write", action: "deny" },
      { context: org.context },
    );

    const allowed = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:read_file",
      sensitivity: "read",
      args: { path: "README.md" },
      reason: "Reading the readme",
    });
    expect(allowed.outcome).toBe("allow");

    // The deny row landed after the session opened, so this session still
    // writes; the next one will not.
    const write = await requestApproval(db, {
      orgId: org.org.id,
      sessionId: opened.session.sessionId,
      toolKey: "github:open_issue",
      sensitivity: "write",
      args: { title: "Later" },
      reason: "Filing a follow-up",
    });
    expect(write.outcome).toBe("approval_required");
    expect(await db.approval.count({ where: { orgId: org.org.id } })).toBe(1);
  });
});
