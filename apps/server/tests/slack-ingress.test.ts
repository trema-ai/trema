import { createHmac, randomUUID } from "node:crypto";

import { type Engine, InMemoryEngine } from "@trema/harness";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { decryptEnvelope, encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import {
  createClientRegistration,
  deleteClientRegistration,
} from "#server/services/connectors/index.js";
import {
  createSlackBinding,
  deleteSlackBinding,
  type SlackIngressNotice,
  SlackIngressService,
  setSlackIdentityLink,
} from "#server/services/messaging/index.js";
import { setPersonalPolicy } from "#server/services/scopes/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 41).toString("base64");
const signingSecret = "slack-ingress-test-signing-secret";
const nowSeconds = 1_800_000_000;

const env = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: databaseUrl,
  TREMA_MODE: "hosted",
  TREMA_AUTH_SECRET: "slack-ingress-auth-secret-at-least-32-characters",
  TREMA_CREDENTIAL_MASTER_KEY: masterKey,
});

function signedRequest(
  body: string,
  contentType = "application/json",
  requestSigningSecret = signingSecret,
): Request {
  const signature = `v0=${createHmac("sha256", requestSigningSecret)
    .update(`v0:${nowSeconds}:${body}`)
    .digest("hex")}`;
  return new Request("https://trema.test/api/v1/messaging/slack/events", {
    method: "POST",
    headers: {
      "content-type": contentType,
      "x-slack-request-timestamp": String(nowSeconds),
      "x-slack-signature": signature,
    },
    body,
  });
}

function appMention(input: {
  eventId: string;
  workspaceId: string;
  channelId?: string;
  userId?: string;
  threadTs?: string;
  ts?: string;
  text?: string;
}) {
  const ts = input.ts ?? "1800000000.000002";
  return {
    api_app_id: "A123ABC",
    event: {
      channel: input.channelId ?? "C123ABC",
      event_ts: ts,
      text: input.text ?? "<@U999BOT> investigate the deploy",
      ...(input.threadTs === undefined ? {} : { thread_ts: input.threadTs }),
      ts,
      type: "app_mention",
      user: input.userId ?? "U123ABC",
    },
    event_id: input.eventId,
    event_time: nowSeconds,
    team_id: input.workspaceId,
    type: "event_callback",
  };
}

function threadReply(input: {
  eventId: string;
  workspaceId: string;
  threadTs: string;
  ts: string;
  text?: string;
}) {
  return {
    event: {
      channel: "C123ABC",
      event_ts: input.ts,
      text: input.text ?? "add the rollback plan",
      thread_ts: input.threadTs,
      ts: input.ts,
      type: "message",
      user: "U123ABC",
    },
    event_id: input.eventId,
    event_time: nowSeconds,
    team_id: input.workspaceId,
    type: "event_callback",
  };
}

function directMessage(
  workspaceId: string,
  eventId = "Ev-direct-message",
  ts = "1800000000.000020",
) {
  return {
    event: {
      channel: "D123ABC",
      channel_type: "im",
      event_ts: ts,
      text: "summarize my open work",
      ts,
      type: "message",
      user: "U123ABC",
    },
    event_id: eventId,
    event_time: nowSeconds,
    team_id: workspaceId,
    type: "event_callback",
  };
}

function lifecycleEvent(
  workspaceId: string,
  event:
    | { type: "app_uninstalled" }
    | { type: "tokens_revoked"; tokens: { bot?: string[]; oauth?: string[] } },
) {
  return {
    api_app_id: "A123ABC",
    event,
    event_id: `Ev-${event.type}-${workspaceId}`,
    event_time: nowSeconds,
    team_id: workspaceId,
    type: "event_callback",
  };
}

function interaction(input: {
  workspaceId: string;
  triggerId: string;
  threadTs: string;
  actionId: string;
  value: string;
  channelId?: string;
}) {
  return new URLSearchParams({
    payload: JSON.stringify({
      actions: [
        {
          action_id: input.actionId,
          action_ts: "1800000001.000001",
          block_id: "controls",
          text: { text: "Act", type: "plain_text" },
          type: "button",
          value: input.value,
        },
      ],
      channel: { id: input.channelId ?? "C123ABC" },
      message: { thread_ts: input.threadTs, ts: "1800000000.000003" },
      team: { id: input.workspaceId },
      trigger_id: input.triggerId,
      type: "block_actions",
      user: { id: "U123ABC", team_id: input.workspaceId },
    }),
  }).toString();
}

integration("Slack ingress", () => {
  const db = createPrismaClient(databaseUrl);

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "SlackIngressDelivery", "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function setup(
    workspaceId = "T123ABC",
    linked = true,
    registrationSigningSecret = signingSecret,
    registrationSource: "customer" | "dynamic" = "customer",
  ) {
    const org = await db.org.create({ data: { name: `Org ${randomUUID()}` } });
    const registration = await createClientRegistration(db, {
      orgId: org.id,
      providerKey: "slack",
      source: registrationSource,
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      signingSecret: registrationSigningSecret,
      masterKey,
    });
    const agent = await db.principal.create({
      data: { orgId: org.id, kind: "agent", displayName: "Trema" },
    });
    const member = await db.principal.create({
      data: { orgId: org.id, kind: "human", displayName: "Ada" },
    });
    const orgScope = await db.scope.create({
      data: { orgId: org.id, kind: "org", name: "Organization" },
    });
    const sharedScope = await db.scope.create({
      data: { orgId: org.id, kind: "shared", name: "Deployments" },
    });
    const connection = await db.connectorConnection.create({
      data: {
        orgId: org.id,
        providerKey: "slack",
        clientRegistrationId: registration.id,
        ownerPrincipalId: agent.id,
        authMode: "oauth2_code",
        config: {
          "team.id": workspaceId,
          "team.name": "Trema Test",
          "authed_user.id": "UINSTALLER",
          app_id: "A123ABC",
          bot_user_id: "U999BOT",
        },
        ciphertext: encryptEnvelope(
          {
            accessToken: "xoxb-safe-test-token",
            raw: {
              authed_user: {
                id: "UINSTALLER",
                access_token: "xoxp-safe-test-token",
                refresh_token: "xoxe-safe-test-token",
              },
            },
          },
          masterKey,
        ),
        providerScopes: ["app_mentions:read", "chat:write"],
      },
    });
    await db.item.create({
      data: {
        orgId: org.id,
        scopeId: orgScope.id,
        kind: "connector",
        title: "Slack",
        body: {
          catalogKey: "slack",
          connectionId: connection.id,
          access: { kind: "scope" },
          enabledTools: "all",
        },
        status: "active",
        disclosure: "standing",
        createdById: member.id,
      },
    });
    await createSlackBinding(db, {
      orgId: org.id,
      actorPrincipalId: member.id,
      connectionId: connection.id,
      workspaceId,
      channelId: "C123ABC",
      scopeId: sharedScope.id,
    });
    if (linked) {
      await setSlackIdentityLink(db, {
        orgId: org.id,
        actorPrincipalId: member.id,
        workspaceId,
        userId: "U123ABC",
        principalId: member.id,
      });
    }
    return { org, member, connection, registration, workspaceId };
  }

  function subject(options: { engine?: Engine; notify?: SlackIngressNotice } = {}) {
    const deferred: Promise<void>[] = [];
    const engine = options.engine ?? new InMemoryEngine();
    const service = new SlackIngressService({
      db,
      env,
      now: () => nowSeconds * 1_000,
      defer: (task) => deferred.push(task),
      runEngineFor: () => engine,
      ...(options.notify === undefined ? {} : { notify: options.notify }),
    });
    return {
      service,
      async drain() {
        while (deferred.length > 0) await Promise.all(deferred.splice(0));
      },
    };
  }

  it("deduplicates retries before they can create a second intent, turn, or run", async () => {
    const fixture = await setup();
    const ingress = subject();
    const body = JSON.stringify(
      appMention({ eventId: "Ev-duplicate", workspaceId: fixture.workspaceId }),
    );

    await Promise.all([
      ingress.service.accept(signedRequest(body)),
      ingress.service.accept(signedRequest(body)),
    ]);
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(db.runQueuedInput.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
  });

  it("keeps a delivery pending until an unresolved run claim can be reclaimed", async () => {
    const fixture = await setup("TPENDINGCLAIM");
    const intentId = "slack:event:Ev-pending-claim";
    const deliveryId = `slack:delivery:${fixture.workspaceId}:C123ABC:${intentId}`;
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const ingress = subject({ notify });
    await db.runIntent.create({
      data: { orgId: fixture.org.id, id: intentId, kind: "message" },
    });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({ eventId: "Ev-pending-claim", workspaceId: fixture.workspaceId }),
        ),
      ),
    );
    await ingress.drain();

    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toMatchObject({ attempt: 1, completedAt: null, leaseUntil: expect.any(Date) });
    await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    expect(notify).not.toHaveBeenCalled();

    await db.runIntent.update({
      where: { orgId_id: { orgId: fixture.org.id, id: intentId } },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    await db.slackIngressDelivery.update({
      where: { id: deliveryId },
      data: { leaseUntil: null },
    });
    await ingress.service.recoverPending();

    await expect(
      db.runIntent.findUniqueOrThrow({
        where: { orgId_id: { orgId: fixture.org.id, id: intentId } },
      }),
    ).resolves.toMatchObject({ runId: expect.any(String), outcome: "started" });
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toMatchObject({ completedAt: expect.any(Date), payload: { kind: "completed" } });
    await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
  });

  it("does not report failure when inbox completion retries after durable routing", async () => {
    const fixture = await setup("TPOSTROUTINGRETRY");
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const ingress = subject({ notify });
    const deliveryId = `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-post-routing-retry`;
    const originalUpdateMany = db.slackIngressDelivery.updateMany.bind(db.slackIngressDelivery);
    const updateMany = vi.spyOn(db.slackIngressDelivery, "updateMany");
    updateMany
      .mockImplementationOnce(originalUpdateMany)
      .mockImplementationOnce(originalUpdateMany)
      .mockImplementationOnce(originalUpdateMany)
      .mockRejectedValueOnce(new Error("transient completion failure"));

    try {
      await ingress.service.accept(
        signedRequest(
          JSON.stringify(
            appMention({
              eventId: "Ev-post-routing-retry",
              workspaceId: fixture.workspaceId,
            }),
          ),
        ),
      );
      await ingress.drain();

      await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
      await expect(
        db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
      ).resolves.toMatchObject({ completedAt: null, leaseUntil: expect.any(Date) });
      expect(notify).not.toHaveBeenCalled();
    } finally {
      updateMany.mockRestore();
    }

    await db.slackIngressDelivery.update({
      where: { id: deliveryId },
      data: { leaseUntil: null },
    });
    await ingress.service.recoverPending();

    await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toMatchObject({ completedAt: expect.any(Date) });
    expect(notify).not.toHaveBeenCalled();
  });

  it("keeps out-of-order and concurrent replies on one durable Slack thread", async () => {
    const fixture = await setup();
    const ingress = subject();
    const threadTs = "1800000000.000001";
    const deliveries = [
      threadReply({
        eventId: "Ev-reply-first",
        workspaceId: fixture.workspaceId,
        threadTs,
        ts: "1800000000.000004",
      }),
      appMention({
        eventId: "Ev-root-late",
        workspaceId: fixture.workspaceId,
        threadTs,
        ts: threadTs,
      }),
      ...Array.from({ length: 4 }, (_, index) =>
        threadReply({
          eventId: `Ev-concurrent-${index}`,
          workspaceId: fixture.workspaceId,
          threadTs,
          ts: `1800000000.00001${index}`,
        }),
      ),
    ];

    await Promise.all(
      deliveries.map((delivery) => ingress.service.accept(signedRequest(JSON.stringify(delivery)))),
    );
    await ingress.drain();

    const runs = await db.agentRun.findMany({ where: { orgId: fixture.org.id } });
    expect(runs).toHaveLength(1);
    expect(runs[0]?.threadRef).toMatch(
      new RegExp(`^slack:${fixture.workspaceId}:C123ABC:${threadTs}:binding:.*:requester:`),
    );
    await expect(db.runQueuedInput.count({ where: { orgId: fixture.org.id } })).resolves.toBe(6);
    await expect(db.contextSession.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
  });

  it("starts a new scoped run when a Slack channel is rebound", async () => {
    const fixture = await setup("TREBOUNDSCOPE");
    const ingress = subject();
    const threadTs = "1800000000.000025";

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-before-rebind",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();

    const oldBinding = await db.binding.findUniqueOrThrow({
      where: {
        orgId_surface_locationRef: {
          orgId: fixture.org.id,
          surface: "slack",
          locationRef: `${fixture.workspaceId}:C123ABC`,
        },
      },
    });
    const replacementScope = await db.scope.create({
      data: { orgId: fixture.org.id, kind: "shared", name: "Incidents" },
    });
    await deleteSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      bindingId: oldBinding.id,
    });
    const replacementBinding = await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C123ABC",
      scopeId: replacementScope.id,
    });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-after-rebind",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();

    const runs = await db.agentRun.findMany({
      where: { orgId: fixture.org.id },
      orderBy: { createdAt: "asc" },
      include: { session: true },
    });
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.session?.scopeId)).toEqual([
      oldBinding.scopeId,
      replacementScope.id,
    ]);
    expect(runs[0]?.threadRef).toContain(`:binding:${oldBinding.id}`);
    expect(runs[1]?.threadRef).toContain(`:binding:${replacementBinding.id}`);
    expect(runs[0]?.threadRef).not.toBe(runs[1]?.threadRef);
    await expect(db.runQueuedInput.count({ where: { orgId: fixture.org.id } })).resolves.toBe(2);
  });

  it("starts a new requester-scoped run when a Slack user is relinked", async () => {
    const fixture = await setup("TRELINKEDUSER");
    const ingress = subject();
    const threadTs = "1800000000.000026";

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-before-relink",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();

    const replacementMember = await db.principal.create({
      data: { orgId: fixture.org.id, kind: "human", displayName: "Grace" },
    });
    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: replacementMember.id,
    });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-after-relink",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();

    const runs = await db.agentRun.findMany({
      where: { orgId: fixture.org.id },
      orderBy: { createdAt: "asc" },
      include: { session: true },
    });
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.session?.requesterPrincipalId)).toEqual([
      fixture.member.id,
      replacementMember.id,
    ]);
    expect(runs[0]?.threadRef).not.toBe(runs[1]?.threadRef);
  });

  it("retains an early reply until a later root delivery owns the thread", async () => {
    const fixture = await setup("TDELAYEDTHREAD");
    const ingress = subject();
    const threadTs = "1800000000.000030";
    const replyId = `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-delayed-reply`;

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-delayed-reply",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: "1800000000.000031",
          }),
        ),
      ),
    );
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
    ).resolves.toMatchObject({
      awaitingThread: true,
      completedAt: null,
      leaseUntil: expect.any(Date),
    });

    // Even an old reply remains recoverable when the durable inbox already
    // contains the matching root delivery that will establish ownership.
    await db.slackIngressDelivery.update({
      where: { id: replyId },
      data: {
        receivedAt: new Date(Date.now() - 10 * 60_000),
        leaseUntil: new Date(0),
      },
    });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-delayed-root",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(2);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
    ).resolves.toEqual(expect.objectContaining({ completedAt: expect.any(Date) }));
  });

  it("does not replay a reply that predates the first owning mention", async () => {
    const fixture = await setup("TPREDATEDTHREAD");
    const ingress = subject();
    const threadTs = "1800000000.000050";
    const replyId = `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-predated-reply`;

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-predated-reply",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: "1800000000.000051",
          }),
        ),
      ),
    );
    await ingress.drain();
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-later-owner",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: "1800000000.000052",
          }),
        ),
      ),
    );
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
    ).resolves.toMatchObject({ awaitingThread: true, completedAt: null });

    await db.slackIngressDelivery.update({
      where: { id: replyId },
      data: { leaseUntil: null },
    });
    await ingress.service.recoverPending();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
    ).resolves.toMatchObject({ awaitingThread: false, completedAt: expect.any(Date) });
  });

  it("immediately resumes a reply when ownership appears while it is leased", async () => {
    const fixture = await setup("TRACEDTHREAD");
    const replyIngress = subject();
    const rootIngress = subject();
    const threadTs = "1800000000.000060";
    const replyId = `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-raced-reply`;
    let releaseLookup!: () => void;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const delayedLookup = lookupBlocked.then(() => null) as unknown as ReturnType<
      typeof db.contextSession.findFirst
    >;
    const contextLookup = vi
      .spyOn(db.contextSession, "findFirst")
      .mockReturnValueOnce(delayedLookup);

    await replyIngress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-raced-reply",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: "1800000000.000061",
          }),
        ),
      ),
    );
    const drainingReply = replyIngress.drain();
    await vi.waitFor(() => expect(contextLookup).toHaveBeenCalledOnce());

    try {
      await rootIngress.service.accept(
        signedRequest(
          JSON.stringify(
            appMention({
              eventId: "Ev-raced-owner",
              workspaceId: fixture.workspaceId,
              threadTs,
              ts: threadTs,
            }),
          ),
        ),
      );
      await rootIngress.drain();
      releaseLookup();
      await drainingReply;

      await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(2);
      await expect(
        db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
      ).resolves.toMatchObject({
        attempt: 1,
        awaitingThread: false,
        completedAt: expect.any(Date),
      });
    } finally {
      releaseLookup();
      contextLookup.mockRestore();
      await Promise.allSettled([drainingReply]);
    }
  });

  it("finalizes an unrelated thread reply after a bounded ownership wait", async () => {
    const fixture = await setup("TUNRELATEDTHREAD");
    const ingress = subject();
    const threadTs = "1800000000.000035";
    const replyId = `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-unrelated-reply`;

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-unrelated-reply",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: "1800000000.000036",
          }),
        ),
      ),
    );
    await ingress.drain();

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-other-thread",
            workspaceId: fixture.workspaceId,
            threadTs: "1800000000.000037",
            ts: "1800000000.000037",
          }),
        ),
      ),
    );
    await ingress.drain();

    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
    ).resolves.toMatchObject({ attempt: 1, awaitingThread: true, completedAt: null });

    await db.slackIngressDelivery.update({
      where: { id: replyId },
      data: {
        receivedAt: new Date(Date.now() - 10 * 60_000),
        leaseUntil: new Date(0),
      },
    });
    await ingress.service.recoverPending();

    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: replyId } }),
    ).resolves.toMatchObject({
      attempt: 2,
      awaitingThread: false,
      completedAt: expect.any(Date),
      payload: { kind: "completed" },
    });
    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
  });

  it("namespaces equal Slack timestamps by workspace and channel", async () => {
    const fixture = await setup("TTHREADNAMESPACE");
    const existingBinding = await db.binding.findUniqueOrThrow({
      where: {
        orgId_surface_locationRef: {
          orgId: fixture.org.id,
          surface: "slack",
          locationRef: `${fixture.workspaceId}:C123ABC`,
        },
      },
    });
    const secondBinding = await createSlackBinding(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      connectionId: fixture.connection.id,
      workspaceId: fixture.workspaceId,
      channelId: "C456DEF",
      scopeId: existingBinding.scopeId,
    });
    const ingress = subject();
    const threadTs = "1800000000.000040";

    await Promise.all(
      ["C123ABC", "C456DEF"].map((channelId, index) =>
        ingress.service.accept(
          signedRequest(
            JSON.stringify(
              appMention({
                eventId: `Ev-namespaced-${index}`,
                workspaceId: fixture.workspaceId,
                channelId,
                threadTs,
                ts: threadTs,
              }),
            ),
          ),
        ),
      ),
    );
    await ingress.drain();

    const runs = await db.agentRun.findMany({
      where: { orgId: fixture.org.id },
      orderBy: { threadRef: "asc" },
      select: { threadRef: true },
    });
    expect(runs).toEqual([
      {
        threadRef: `slack:${fixture.workspaceId}:C123ABC:${threadTs}:binding:${existingBinding.id}:requester:${fixture.member.id}`,
      },
      {
        threadRef: `slack:${fixture.workspaceId}:C456DEF:${threadTs}:binding:${secondBinding.id}:requester:${fixture.member.id}`,
      },
    ]);
    await expect(db.contextSession.count({ where: { orgId: fixture.org.id } })).resolves.toBe(2);
  });

  it("acknowledges before slow run scheduling completes", async () => {
    const fixture = await setup();
    let release!: () => void;
    const scheduling = new Promise<void>((resolve) => {
      release = resolve;
    });
    const engine: Engine = { enqueue: vi.fn(() => scheduling) };
    const ingress = subject({ engine });
    const body = JSON.stringify(
      appMention({ eventId: "Ev-slow", workspaceId: fixture.workspaceId }),
    );

    await expect(ingress.service.accept(signedRequest(body))).resolves.toEqual({});
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({
        where: { id: `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-slow` },
      }),
    ).resolves.toMatchObject({ completedAt: null });
    expect(engine.enqueue).not.toHaveBeenCalled();
    release();
    await ingress.drain();
    expect(engine.enqueue).toHaveBeenCalledOnce();
  });

  it("recovers a verified delivery left pending by an earlier process", async () => {
    const fixture = await setup("TRECOVERED");
    const intentId = "slack:event:Ev-recovered";
    const deliveryId = `slack:delivery:${fixture.workspaceId}:C123ABC:${intentId}`;
    await db.slackIngressDelivery.create({
      data: {
        id: deliveryId,
        payload: {
          kind: "surface",
          connectionIds: [fixture.connection.id],
          event: {
            type: "message",
            surface: "slack",
            intentId,
            surfaceRef: {
              surface: "slack",
              locationRef: `${fixture.workspaceId}:C123ABC`,
              channelRef: "C123ABC",
              threadRef: "1800000000.000041",
              teamRef: fixture.workspaceId,
              recipient: { teamRef: fixture.workspaceId, userRef: "U123ABC" },
            },
            authorRef: "U123ABC",
            text: "<@U999BOT> recover this delivery",
            at: "2027-01-15T08:00:00.000Z",
            nativeMessageRef: "1800000000.000041",
            nativeKind: "app-mention",
          },
        },
      },
    });
    const recovered = subject();

    await recovered.service.recoverPending();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toEqual(
      expect.objectContaining({ completedAt: expect.any(Date), payload: { kind: "completed" } }),
    );
  });

  it("retries a top-level inbox failure without another Slack webhook", async () => {
    const fixture = await setup("TRECOVERYRETRY");
    const ingress = subject();
    const findMany = vi
      .spyOn(db.slackIngressDelivery, "findMany")
      .mockRejectedValueOnce(new Error("transient inbox query failure"));

    try {
      await ingress.service.accept(
        signedRequest(
          JSON.stringify(
            appMention({
              eventId: "Ev-recovery-retry",
              workspaceId: fixture.workspaceId,
            }),
          ),
        ),
      );
      await expect(ingress.drain()).rejects.toThrow("transient inbox query failure");

      await new Promise((resolve) => setTimeout(resolve, 1_100));
      await ingress.drain();

      await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
      await expect(
        db.slackIngressDelivery.findUniqueOrThrow({
          where: {
            id: `slack:delivery:${fixture.workspaceId}:C123ABC:slack:event:Ev-recovery-retry`,
          },
        }),
      ).resolves.toMatchObject({ completedAt: expect.any(Date) });
    } finally {
      findMany.mockRestore();
    }
  });

  it("prunes only completed ingress tombstones after the retention window", async () => {
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1_000);
    const recent = new Date();
    await db.slackIngressDelivery.createMany({
      data: [
        { id: "old-completed", payload: { kind: "completed" }, completedAt: old },
        { id: "recent-completed", payload: { kind: "completed" }, completedAt: recent },
        {
          id: "old-pending",
          payload: { kind: "pending" },
          receivedAt: old,
          leaseUntil: new Date(Date.now() + 24 * 60 * 60 * 1_000),
        },
      ],
    });

    await subject().service.recoverPending();

    const retained = await db.slackIngressDelivery.findMany({
      orderBy: { id: "asc" },
      select: { id: true },
    });
    expect(retained).toEqual([{ id: "old-pending" }, { id: "recent-completed" }]);
  });

  it("does not replay a delivery through a replacement installation", async () => {
    const original = await setup("TREPLAYBOUND");
    const intentId = "slack:event:Ev-replay-bound";
    const deliveryId = `slack:delivery:${original.workspaceId}:C123ABC:${intentId}`;
    await db.slackIngressDelivery.create({
      data: {
        id: deliveryId,
        payload: {
          kind: "surface",
          connectionIds: [original.connection.id],
          event: {
            type: "message",
            surface: "slack",
            intentId,
            surfaceRef: {
              surface: "slack",
              locationRef: `${original.workspaceId}:C123ABC`,
              channelRef: "C123ABC",
              threadRef: "1800000000.000042",
              teamRef: original.workspaceId,
              recipient: { teamRef: original.workspaceId, userRef: "U123ABC" },
            },
            authorRef: "U123ABC",
            text: "<@U999BOT> do not cross installations",
            at: "2027-01-15T08:00:00.000Z",
            nativeMessageRef: "1800000000.000042",
            nativeKind: "app-mention",
          },
        },
      },
    });
    await db.connectorConnection.update({
      where: { id: original.connection.id },
      data: { revokedAt: new Date() },
    });
    const replacement = await setup(original.workspaceId);
    const recovered = subject();

    await recovered.service.recoverPending();

    await expect(
      db.runIntent.count({ where: { orgId: { in: [original.org.id, replacement.org.id] } } }),
    ).resolves.toBe(0);
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toEqual(expect.objectContaining({ completedAt: expect.any(Date) }));
  });

  it("resolves direct messages through the linked member's personal scope", async () => {
    const fixture = await setup();
    await setPersonalPolicy(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      enabled: true,
    });
    const ingress = subject();

    await ingress.service.accept(signedRequest(JSON.stringify(directMessage(fixture.workspaceId))));
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          directMessage(fixture.workspaceId, "Ev-direct-message-follow-up", "1800000000.000021"),
        ),
      ),
    );
    await ingress.drain();

    const run = await db.agentRun.findFirstOrThrow({
      where: { orgId: fixture.org.id },
      include: { session: { include: { scope: true } } },
    });
    expect(run.threadRef).toMatch(
      new RegExp(
        `^slack:${fixture.workspaceId}:D123ABC:binding:.*:requester:${fixture.member.id}$`,
      ),
    );
    expect(run.session?.scope.kind).toBe("personal");
    expect(run.session?.threadRef).toBeNull();
    await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
    await expect(db.runQueuedInput.count({ where: { orgId: fixture.org.id } })).resolves.toBe(2);
    await expect(
      db.binding.findUnique({
        where: {
          orgId_surface_locationRef: {
            orgId: fixture.org.id,
            surface: "slack",
            locationRef: `${fixture.workspaceId}:D123ABC`,
          },
        },
      }),
    ).resolves.toMatchObject({ scopeId: run.session?.scopeId });

    await db.agentRun.update({ where: { id: run.id }, data: { state: "awaiting_input" } });
    await db.runElicitation.create({
      data: {
        id: "elicitation-slack-dm",
        orgId: fixture.org.id,
        runId: run.id,
        event: {
          type: "elicitation",
          elicitationId: "elicitation-slack-dm",
          kind: "choice",
          prompt: "Choose",
          options: [{ id: "approve", label: "Approve" }],
          blocking: true,
        },
      },
    });
    await ingress.service.accept(
      signedRequest(
        interaction({
          workspaceId: fixture.workspaceId,
          channelId: "D123ABC",
          triggerId: "trigger-dm-approve",
          threadTs: "1800000000.000021",
          actionId: "input:elicitation-slack-dm:button:0",
          value: "approve",
        }),
        "application/x-www-form-urlencoded",
      ),
    );
    await ingress.drain();
    await expect(
      db.runElicitation.findUniqueOrThrow({ where: { id: "elicitation-slack-dm" } }),
    ).resolves.toMatchObject({ resolution: { optionId: "approve" } });
  });

  it("re-resolves a direct message personal scope after identity relinking", async () => {
    const fixture = await setup("TDMRELINK");
    await setPersonalPolicy(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      enabled: true,
    });
    const ingress = subject();

    await ingress.service.accept(
      signedRequest(JSON.stringify(directMessage(fixture.workspaceId, "Ev-dm-before-relink"))),
    );
    await ingress.drain();

    const replacementMember = await db.principal.create({
      data: { orgId: fixture.org.id, kind: "human", displayName: "Grace" },
    });
    await setSlackIdentityLink(db, {
      orgId: fixture.org.id,
      actorPrincipalId: fixture.member.id,
      workspaceId: fixture.workspaceId,
      userId: "U123ABC",
      principalId: replacementMember.id,
    });
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          directMessage(fixture.workspaceId, "Ev-dm-after-relink", "1800000000.000022"),
        ),
      ),
    );
    await ingress.drain();

    const runs = await db.agentRun.findMany({
      where: { orgId: fixture.org.id },
      orderBy: { createdAt: "asc" },
      include: { session: { include: { scope: true } } },
    });
    expect(runs).toHaveLength(2);
    expect(runs.map((run) => run.session?.requesterPrincipalId)).toEqual([
      fixture.member.id,
      replacementMember.id,
    ]);
    expect(runs.map((run) => run.session?.scope.ownerId)).toEqual([
      fixture.member.id,
      replacementMember.id,
    ]);
    expect(runs[0]?.session?.scopeId).not.toBe(runs[1]?.session?.scopeId);
    await expect(
      db.binding.findUnique({
        where: {
          orgId_surface_locationRef: {
            orgId: fixture.org.id,
            surface: "slack",
            locationRef: `${fixture.workspaceId}:D123ABC`,
          },
        },
      }),
    ).resolves.toMatchObject({ scopeId: runs[1]?.session?.scopeId });
  });

  it("ignores unmentioned replies outside Trema-owned Slack threads", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const fixture = await setup("TUNRELATEDTHREAD", false);
    const ingress = subject({ notify });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-unrelated-thread",
            workspaceId: fixture.workspaceId,
            threadTs: "1800000000.000030",
            ts: "1800000000.000031",
            text: "ordinary team discussion",
          }),
        ),
      ),
    );
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    await expect(db.agentRun.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    await expect(db.contextSession.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    expect(notify).not.toHaveBeenCalled();
  });

  it("creates no intent for unlinked users, revoked installations, or bot loops", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const unlinked = await setup("TUNLINKED", false);
    const first = subject({ notify });
    await first.service.accept(
      signedRequest(
        JSON.stringify(appMention({ eventId: "Ev-unlinked", workspaceId: unlinked.workspaceId })),
      ),
    );
    await first.drain();
    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channelId: "C123ABC",
        visibility: "private",
        text: expect.stringMatching(
          /http:\/\/127\.0\.0\.1:5173\/link\/slack\?token=[^|>]+\|Link your Trema account>/,
        ),
        orgId: unlinked.org.id,
        connectionId: unlinked.connection.id,
      }),
    );
    await expect(
      db.identityLinkChallenge.count({
        where: {
          orgId: unlinked.org.id,
          surface: "slack",
          externalUserId: `${unlinked.workspaceId}:U123ABC`,
        },
      }),
    ).resolves.toBe(1);
    expect(notify.mock.calls[0]?.[0].text).not.toMatch(/tokenHash|xoxb-/);

    const revoked = await setup("TREVOKED");
    await db.connectorConnection.update({
      where: { id: revoked.connection.id },
      data: { revokedAt: new Date() },
    });
    const second = subject({ notify });
    await expect(
      second.service.accept(
        signedRequest(
          JSON.stringify(appMention({ eventId: "Ev-revoked", workspaceId: revoked.workspaceId })),
        ),
      ),
    ).rejects.toThrow("No Slack signing secret is configured for this delivery");
    await second.drain();

    const active = await setup("TBOTLOOP");
    const third = subject({ notify });
    await third.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-bot-loop",
            workspaceId: active.workspaceId,
            userId: "U999BOT",
          }),
        ),
      ),
    );
    await third.drain();

    await expect(db.runIntent.count()).resolves.toBe(0);
    expect(notify).toHaveBeenCalledOnce();
  });

  it("returns the generic safe rejection for deactivated linked members without minting", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const fixture = await setup("TDEACTIVATEDLINK", true);
    await db.principal.update({
      where: { id: fixture.member.id },
      data: { deactivatedAt: new Date() },
    });
    const ingress = subject({ notify });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({ eventId: "Ev-deactivated", workspaceId: fixture.workspaceId }),
        ),
      ),
    );
    await ingress.drain();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channelId: "C123ABC",
        visibility: "private",
        text: "Trema can't start work from this Slack account or conversation. Ask a Trema administrator to check the Slack connection, member link, and conversation binding.",
        orgId: fixture.org.id,
        connectionId: fixture.connection.id,
      }),
    );
    await expect(
      db.identityLinkChallenge.count({
        where: {
          orgId: fixture.org.id,
          surface: "slack",
          externalUserId: `${fixture.workspaceId}:U123ABC`,
        },
      }),
    ).resolves.toBe(0);
    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
  });

  it("emits one rejection notice for a mentioned reply's message and app-mention deliveries", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const unlinked = await setup("TMENTIONSHADOW", false);
    const ingress = subject({ notify });
    const threadTs = "1800000000.000001";
    const ts = "1800000000.000002";

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-mention-shadow",
            workspaceId: unlinked.workspaceId,
            threadTs,
            ts,
            text: "<@U999BOT> investigate the deploy",
          }),
        ),
      ),
    );
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-mention-canonical",
            workspaceId: unlinked.workspaceId,
            threadTs,
            ts,
          }),
        ),
      ),
    );
    await ingress.drain();

    expect(notify).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ visibility: "private" }));
    await expect(db.runIntent.count({ where: { orgId: unlinked.org.id } })).resolves.toBe(0);

    const unbound = await setup("TUNBOUNDMENTION");
    await db.binding.deleteMany({ where: { orgId: unbound.org.id, surface: "slack" } });
    const unboundIngress = subject({ notify });
    await unboundIngress.service.accept(
      signedRequest(
        JSON.stringify(
          threadReply({
            eventId: "Ev-unbound-shadow",
            workspaceId: unbound.workspaceId,
            threadTs,
            ts,
            text: "<@U999BOT> investigate the deploy",
          }),
        ),
      ),
    );
    await unboundIngress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-unbound-canonical",
            workspaceId: unbound.workspaceId,
            threadTs,
            ts,
          }),
        ),
      ),
    );
    await unboundIngress.drain();

    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenLastCalledWith(expect.objectContaining({ visibility: "channel" }));
    await expect(db.runIntent.count({ where: { orgId: unbound.org.id } })).resolves.toBe(0);
  });

  it("keeps an installation on its original app until that registration is replaced", async () => {
    const originalSecret = "original-slack-signing-secret";
    const fixture = await setup("TAPPASSOCIATION", true, originalSecret, "dynamic");
    await createClientRegistration(db, {
      orgId: fixture.org.id,
      providerKey: "slack",
      source: "customer",
      clientId: "new-preferred-client",
      clientSecret: "new-preferred-secret",
      signingSecret: "new-preferred-signing-secret",
      masterKey,
    });
    const ingress = subject();
    const body = JSON.stringify(
      appMention({ eventId: "Ev-original-app", workspaceId: fixture.workspaceId }),
    );

    await expect(
      ingress.service.accept(signedRequest(body, "application/json", originalSecret)),
    ).resolves.toEqual({});
    await ingress.drain();
    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);

    await createClientRegistration(db, {
      orgId: fixture.org.id,
      providerKey: "slack",
      source: "dynamic",
      clientId: "replacement-client",
      clientSecret: "replacement-secret",
      signingSecret: "replacement-signing-secret",
      masterKey,
      replace: true,
    });
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });

    await deleteClientRegistration(db, fixture.org.id, fixture.registration.id);
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: fixture.connection.id } }),
    ).resolves.toMatchObject({
      clientRegistrationId: null,
      revokedAt: expect.any(Date),
    });
  });

  it("rejects a revoked app secret after the workspace is reinstalled", async () => {
    const workspaceId = "TREINSTALLED";
    const retiredSecret = "retired-slack-signing-secret";
    const activeSecret = "active-slack-signing-secret";
    const retired = await setup(workspaceId, true, retiredSecret);
    await db.connectorConnection.update({
      where: { id: retired.connection.id },
      data: { revokedAt: new Date() },
    });
    const active = await setup(workspaceId, true, activeSecret);
    const ingress = subject();
    const body = JSON.stringify(appMention({ eventId: "Ev-reinstalled", workspaceId }));

    await expect(
      ingress.service.accept(signedRequest(body, "application/json", retiredSecret)),
    ).rejects.toMatchObject({ code: "invalid_request" });
    await expect(
      ingress.service.accept(signedRequest(body, "application/json", activeSecret)),
    ).resolves.toEqual({});
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: retired.org.id } })).resolves.toBe(0);
    await expect(db.runIntent.count({ where: { orgId: active.org.id } })).resolves.toBe(1);
  });

  it("does not use another organization's secret for an event without a workspace hint", async () => {
    const sourceSecret = "source-org-slack-signing-secret";
    const targetSecret = "target-org-slack-signing-secret";
    await setup("TSOURCE", true, sourceSecret);
    const target = await setup("TTARGET", true, targetSecret);
    const ingress = subject();
    const body = JSON.stringify({
      enterprise_id: target.workspaceId,
      event: {
        channel: "C123ABC",
        event_ts: "1800000000.000004",
        text: "forged cross-tenant reply",
        thread_ts: "1800000000.000001",
        ts: "1800000000.000004",
        type: "message",
        user: "U123ABC",
      },
      event_id: "Ev-cross-tenant",
      event_time: nowSeconds,
      type: "event_callback",
    });

    await expect(
      ingress.service.accept(signedRequest(body, "application/json", sourceSecret)),
    ).rejects.toThrow("No Slack signing secret is configured for this delivery");
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: target.org.id } })).resolves.toBe(0);
  });

  it("revokes installations when Slack reports an uninstall or bot-token revocation", async () => {
    const uninstalled = await setup("TUNINSTALLED");
    const botRevoked = await setup("TBOTREVOKED");
    const ingress = subject();

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(lifecycleEvent(uninstalled.workspaceId, { type: "app_uninstalled" })),
      ),
    );
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          lifecycleEvent(botRevoked.workspaceId, {
            type: "tokens_revoked",
            tokens: { bot: ["U999BOT"] },
          }),
        ),
      ),
    );
    await ingress.drain();

    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: uninstalled.connection.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
    await expect(
      db.connectorConnection.findUniqueOrThrow({ where: { id: botRevoked.connection.id } }),
    ).resolves.toMatchObject({ revokedAt: expect.any(Date) });
  });

  it("removes a revoked Slack user token without disabling the active bot", async () => {
    const fixture = await setup("TUSERREVOKED");
    const ingress = subject();

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          lifecycleEvent(fixture.workspaceId, {
            type: "tokens_revoked",
            tokens: { oauth: ["UINSTALLER"] },
          }),
        ),
      ),
    );
    await ingress.drain();

    const connection = await db.connectorConnection.findUniqueOrThrow({
      where: { id: fixture.connection.id },
    });
    expect(connection.revokedAt).toBeNull();
    expect(decryptEnvelope(connection.ciphertext, masterKey)).toEqual({
      accessToken: "xoxb-safe-test-token",
      raw: { authed_user: { id: "UINSTALLER" } },
    });
  });

  it("posts a public setup link when a conversation is not bound", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const fixture = await setup("TUNBOUND");
    await db.binding.deleteMany({
      where: {
        orgId: fixture.org.id,
        surface: "slack",
        locationRef: `${fixture.workspaceId}:C123ABC`,
      },
    });
    const ingress = subject({ notify });

    await ingress.service.accept(
      signedRequest(
        JSON.stringify(appMention({ eventId: "Ev-unbound", workspaceId: fixture.workspaceId })),
      ),
    );
    await ingress.drain();

    await expect(db.runIntent.count({ where: { orgId: fixture.org.id } })).resolves.toBe(0);
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123ABC",
        visibility: "channel",
        text: expect.stringContaining(
          "http://127.0.0.1:5173/settings/messaging?setup=slack-channel&workspaceId=TUNBOUND&channelId=C123ABC",
        ),
      }),
    );
    expect(notify.mock.calls[0]?.[0].text).toContain("|Configure channel>");
  });

  it("delivers an unlinked Slack identity notice privately in channels and DMs", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);

    const channel = await setup("TSELFLINKCH", false);
    const channelIngress = subject({ notify });
    await channelIngress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({ eventId: "Ev-self-link-channel", workspaceId: channel.workspaceId }),
        ),
      ),
    );
    await channelIngress.drain();
    expect(notify).toHaveBeenCalledWith(
      expect.objectContaining({
        channelId: "C123ABC",
        directMessage: false,
        visibility: "private",
        text: expect.stringContaining("/link/slack?token="),
      }),
    );

    const dm = await setup("TSELFLINKDM", false);
    const dmIngress = subject({ notify });
    await dmIngress.service.accept(
      signedRequest(JSON.stringify(directMessage(dm.workspaceId, "Ev-self-link-dm"))),
    );
    await dmIngress.drain();
    expect(notify).toHaveBeenLastCalledWith(
      expect.objectContaining({
        channelId: "D123ABC",
        directMessage: true,
        visibility: "private",
        text: expect.stringContaining("/link/slack?token="),
      }),
    );
    await expect(db.runIntent.count()).resolves.toBe(0);
  });

  it("routes approval and cancellation controls through durable target intents", async () => {
    const fixture = await setup();
    const ingress = subject();
    const threadTs = "1800000000.000001";
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-controls-root",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();
    const run = await db.agentRun.findFirstOrThrow({ where: { orgId: fixture.org.id } });
    await db.agentRun.update({ where: { id: run.id }, data: { state: "awaiting_input" } });
    await db.runElicitation.create({
      data: {
        id: "elicitation-slack-1",
        orgId: fixture.org.id,
        runId: run.id,
        event: {
          type: "elicitation",
          elicitationId: "elicitation-slack-1",
          kind: "choice",
          prompt: "Choose",
          options: [{ id: "approve", label: "Approve" }],
          blocking: true,
        },
      },
    });

    const approvalBody = interaction({
      workspaceId: fixture.workspaceId,
      triggerId: "trigger-approve",
      threadTs,
      actionId: "input:elicitation-slack-1:button:0",
      value: "approve",
    });
    await ingress.service.accept(signedRequest(approvalBody, "application/x-www-form-urlencoded"));
    await ingress.drain();
    await expect(
      db.runElicitation.findUniqueOrThrow({ where: { id: "elicitation-slack-1" } }),
    ).resolves.toMatchObject({ resolution: { optionId: "approve" } });

    const stopBody = interaction({
      workspaceId: fixture.workspaceId,
      triggerId: "trigger-stop",
      threadTs,
      actionId: "trema:stop",
      value: run.id,
    });
    await ingress.service.accept(signedRequest(stopBody, "application/x-www-form-urlencoded"));
    await ingress.drain();
    await expect(db.runStop.findUnique({ where: { runId: run.id } })).resolves.toMatchObject({
      intentId: "slack:interaction:trigger-stop",
    });
  });

  it("keeps an interaction pending until an unresolved intent claim can be reclaimed", async () => {
    const fixture = await setup("TPENDINGINTERACTION");
    const ingress = subject();
    const threadTs = "1800000000.000061";
    await ingress.service.accept(
      signedRequest(
        JSON.stringify(
          appMention({
            eventId: "Ev-pending-interaction-root",
            workspaceId: fixture.workspaceId,
            threadTs,
            ts: threadTs,
          }),
        ),
      ),
    );
    await ingress.drain();
    const run = await db.agentRun.findFirstOrThrow({ where: { orgId: fixture.org.id } });
    await db.agentRun.update({ where: { id: run.id }, data: { state: "awaiting_input" } });
    const elicitationId = "elicitation-pending-interaction";
    await db.runElicitation.create({
      data: {
        id: elicitationId,
        orgId: fixture.org.id,
        runId: run.id,
        event: {
          type: "elicitation",
          elicitationId,
          kind: "choice",
          prompt: "Choose",
          options: [{ id: "approve", label: "Approve" }],
          blocking: true,
        },
      },
    });
    const intentId = "slack:interaction:trigger-pending-interaction";
    await db.runIntent.create({
      data: { orgId: fixture.org.id, id: intentId, kind: "resolve", targetId: elicitationId },
    });
    await ingress.service.accept(
      signedRequest(
        interaction({
          workspaceId: fixture.workspaceId,
          triggerId: "trigger-pending-interaction",
          threadTs,
          actionId: `input:${elicitationId}:button:0`,
          value: "approve",
        }),
        "application/x-www-form-urlencoded",
      ),
    );
    await ingress.drain();

    const deliveryId = `slack:delivery:${fixture.workspaceId}:C123ABC:${intentId}`;
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toMatchObject({ attempt: 1, completedAt: null, leaseUntil: expect.any(Date) });
    await expect(
      db.runElicitation.findUniqueOrThrow({ where: { id: elicitationId } }),
    ).resolves.toMatchObject({ resolution: null });

    await db.runIntent.update({
      where: { orgId_id: { orgId: fixture.org.id, id: intentId } },
      data: { createdAt: new Date(Date.now() - 61_000) },
    });
    await db.slackIngressDelivery.update({
      where: { id: deliveryId },
      data: { leaseUntil: null },
    });
    await ingress.service.recoverPending();

    await expect(
      db.runElicitation.findUniqueOrThrow({ where: { id: elicitationId } }),
    ).resolves.toMatchObject({ resolution: { optionId: "approve" } });
    await expect(
      db.slackIngressDelivery.findUniqueOrThrow({ where: { id: deliveryId } }),
    ).resolves.toMatchObject({ completedAt: expect.any(Date), payload: { kind: "completed" } });
  });

  it("rejects stale approval controls after a channel rebind or user relink", async () => {
    const notify = vi.fn<SlackIngressNotice>(async () => undefined);
    const ingress = subject({ notify });

    async function createPendingApproval(
      fixture: Awaited<ReturnType<typeof setup>>,
      suffix: string,
    ) {
      const threadTs = `1800000000.0000${suffix}`;
      await ingress.service.accept(
        signedRequest(
          JSON.stringify(
            appMention({
              eventId: `Ev-stale-control-${suffix}`,
              workspaceId: fixture.workspaceId,
              threadTs,
              ts: threadTs,
            }),
          ),
        ),
      );
      await ingress.drain();
      const run = await db.agentRun.findFirstOrThrow({
        where: { orgId: fixture.org.id },
        orderBy: { createdAt: "desc" },
      });
      await db.agentRun.update({ where: { id: run.id }, data: { state: "awaiting_input" } });
      const elicitationId = `elicitation-stale-${suffix}`;
      await db.runElicitation.create({
        data: {
          id: elicitationId,
          orgId: fixture.org.id,
          runId: run.id,
          event: {
            type: "elicitation",
            elicitationId,
            kind: "choice",
            prompt: "Choose",
            options: [{ id: "approve", label: "Approve" }],
            blocking: true,
          },
        },
      });
      return { elicitationId, threadTs };
    }

    const rebound = await setup("TSTALEBINDING");
    const reboundTarget = await createPendingApproval(rebound, "51");
    const oldBinding = await db.binding.findUniqueOrThrow({
      where: {
        orgId_surface_locationRef: {
          orgId: rebound.org.id,
          surface: "slack",
          locationRef: `${rebound.workspaceId}:C123ABC`,
        },
      },
    });
    const replacementScope = await db.scope.create({
      data: { orgId: rebound.org.id, kind: "shared", name: "Replacement" },
    });
    await deleteSlackBinding(db, {
      orgId: rebound.org.id,
      actorPrincipalId: rebound.member.id,
      bindingId: oldBinding.id,
    });
    await createSlackBinding(db, {
      orgId: rebound.org.id,
      actorPrincipalId: rebound.member.id,
      connectionId: rebound.connection.id,
      workspaceId: rebound.workspaceId,
      channelId: "C123ABC",
      scopeId: replacementScope.id,
    });

    const relinked = await setup("TSTALEIDENTITY");
    const relinkedTarget = await createPendingApproval(relinked, "52");
    const replacementMember = await db.principal.create({
      data: { orgId: relinked.org.id, kind: "human", displayName: "Grace" },
    });
    await setSlackIdentityLink(db, {
      orgId: relinked.org.id,
      actorPrincipalId: relinked.member.id,
      workspaceId: relinked.workspaceId,
      userId: "U123ABC",
      principalId: replacementMember.id,
    });

    for (const [fixture, target] of [
      [rebound, reboundTarget],
      [relinked, relinkedTarget],
    ] as const) {
      await ingress.service.accept(
        signedRequest(
          interaction({
            workspaceId: fixture.workspaceId,
            triggerId: `trigger-${target.elicitationId}`,
            threadTs: target.threadTs,
            actionId: `input:${target.elicitationId}:button:0`,
            value: "approve",
          }),
          "application/x-www-form-urlencoded",
        ),
      );
    }
    await ingress.drain();

    for (const target of [reboundTarget, relinkedTarget]) {
      await expect(
        db.runElicitation.findUniqueOrThrow({ where: { id: target.elicitationId } }),
      ).resolves.toMatchObject({ resolution: null });
    }
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify).toHaveBeenNthCalledWith(1, expect.objectContaining({ visibility: "private" }));
    expect(notify).toHaveBeenNthCalledWith(2, expect.objectContaining({ visibility: "private" }));
  });
});
