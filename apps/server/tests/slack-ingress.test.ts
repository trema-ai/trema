import { createHmac, randomUUID } from "node:crypto";

import { type Engine, InMemoryEngine } from "@trema/harness";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { createClientRegistration } from "#server/services/connectors/index.js";
import {
  createSlackBinding,
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

function signedRequest(body: string, contentType = "application/json"): Request {
  const signature = `v0=${createHmac("sha256", signingSecret)
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

function directMessage(workspaceId: string) {
  return {
    event: {
      channel: "D123ABC",
      channel_type: "im",
      event_ts: "1800000000.000020",
      text: "summarize my open work",
      ts: "1800000000.000020",
      type: "message",
      user: "U123ABC",
    },
    event_id: "Ev-direct-message",
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
      channel: { id: "C123ABC" },
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
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function setup(workspaceId = "T123ABC", linked = true) {
    const org = await db.org.create({ data: { name: `Org ${randomUUID()}` } });
    await createClientRegistration(db, {
      orgId: org.id,
      providerKey: "slack",
      source: "customer",
      clientId: "slack-client-id",
      clientSecret: "slack-client-secret",
      signingSecret,
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
        ownerPrincipalId: agent.id,
        authMode: "oauth2_code",
        config: {
          "team.id": workspaceId,
          "team.name": "Trema Test",
          bot_user_id: "U999BOT",
        },
        ciphertext: encryptEnvelope({ accessToken: "xoxb-safe-test-token" }, masterKey),
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
    return { org, member, connection, workspaceId };
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
    expect(runs[0]?.threadRef).toBe(threadTs);
    await expect(db.runQueuedInput.count({ where: { orgId: fixture.org.id } })).resolves.toBe(6);
    await expect(db.contextSession.count({ where: { orgId: fixture.org.id } })).resolves.toBe(1);
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
    expect(engine.enqueue).not.toHaveBeenCalled();
    release();
    await ingress.drain();
    expect(engine.enqueue).toHaveBeenCalledOnce();
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
    await ingress.drain();

    const run = await db.agentRun.findFirstOrThrow({
      where: { orgId: fixture.org.id },
      include: { session: { include: { scope: true } } },
    });
    expect(run.threadRef).toBe("1800000000.000020");
    expect(run.session?.scope.kind).toBe("personal");
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
      }),
    );

    const revoked = await setup("TREVOKED");
    await db.connectorConnection.update({
      where: { id: revoked.connection.id },
      data: { revokedAt: new Date() },
    });
    const second = subject({ notify });
    await second.service.accept(
      signedRequest(
        JSON.stringify(appMention({ eventId: "Ev-revoked", workspaceId: revoked.workspaceId })),
      ),
    );
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
});
