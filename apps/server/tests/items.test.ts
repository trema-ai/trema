import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { ItemStatus } from "#/generated/prisma/client.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { itemsRouter } from "#/rpc/items.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import {
  agentWritePolicy,
  createItem,
  disclosureDefaults,
  lifecycleTransitions,
} from "#/services/items/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

integration("item envelope", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "item-envelope-integration-secret-at-least-32-chars",
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

  async function createOrg(name = "Item Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    const agent = await db.principal.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "agent" },
    });
    return { ...signedUp, ...membership, orgScope, agent };
  }

  async function createMemory(
    org: Awaited<ReturnType<typeof createOrg>>,
    input: {
      title: string;
      type?: "fact" | "preference" | "rule" | "procedure";
      content?: string;
      scopeId?: string;
      disclosure?: "standing" | "retrieved";
    },
  ) {
    return call(
      itemsRouter.create,
      {
        scopeId: input.scopeId ?? org.orgScope.id,
        kind: "memory",
        title: input.title,
        body: { type: input.type ?? "fact", content: input.content ?? input.title },
        ...(input.disclosure ? { disclosure: input.disclosure } : {}),
      },
      { context: org.context },
    );
  }

  it("allows exactly the lifecycle transition table and records the confirmer", async () => {
    const org = await createOrg();
    const actions = ["activate", "archive", "restore"] as const;
    const statuses = ["proposed", "active", "archived"] as const;

    for (const action of actions) {
      for (const status of statuses) {
        const item = await db.item.create({
          data: {
            orgId: org.org.id,
            scopeId: org.orgScope.id,
            kind: "memory",
            title: `${action}-${status}`,
            body: { type: "fact", content: `${action}-${status}` },
            status,
            disclosure: "retrieved",
            createdById: org.principal.id,
          },
        });
        const operation = itemsRouter[action];
        const expected = (lifecycleTransitions[action] as Partial<Record<ItemStatus, ItemStatus>>)[
          status
        ];

        if (expected) {
          const result = await call(operation, { id: item.id }, { context: org.context });
          expect(result.status).toBe(expected);
          if (action === "activate") {
            expect(result.confirmedById).toBe(org.principal.id);
          }
        } else {
          await expect(
            call(operation, { id: item.id }, { context: org.context }),
          ).rejects.toMatchObject({ code: "BAD_REQUEST" });
        }
      }
    }
  });

  it("retains each prior title and body while monotonically incrementing version", async () => {
    const org = await createOrg();
    const created = await createMemory(org, {
      title: "Staging URL",
      content: "The staging URL is stage.one.example",
    });
    const bodyUpdated = await call(
      itemsRouter.update,
      {
        id: created.id,
        body: { type: "fact", content: "The staging URL is stage.two.example" },
      },
      { context: org.context },
    );
    const titleUpdated = await call(
      itemsRouter.update,
      { id: created.id, title: "Current staging URL" },
      { context: org.context },
    );

    expect(bodyUpdated.version).toBe(2);
    expect(titleUpdated.version).toBe(3);
    const versions = await call(itemsRouter.versions, { id: created.id }, { context: org.context });
    expect(versions).toHaveLength(2);
    expect(versions[0]).toMatchObject({
      version: 2,
      title: "Staging URL",
      body: { type: "fact", content: "The staging URL is stage.two.example" },
    });
    expect(versions[1]).toMatchObject({
      version: 1,
      title: "Staging URL",
      body: { type: "fact", content: "The staging URL is stage.one.example" },
    });
    expect(versions.every(({ createdAt }) => !Number.isNaN(Date.parse(createdAt)))).toBe(true);
  });

  it("authorizes version history at the item's scope and reports missing items", async () => {
    const org = await createOrg();
    const item = await createMemory(org, { title: "Private history" });
    const outsider = await signUp("History Outsider");
    await db.principal.create({
      data: {
        orgId: org.org.id,
        kind: "human",
        authId: outsider.user.id,
        displayName: outsider.user.name,
        email: outsider.user.email,
      },
    });
    await db.session.updateMany({
      where: { userId: outsider.user.id },
      data: { activeOrgId: org.org.id },
    });

    await expect(
      call(itemsRouter.versions, { id: item.id }, { context: outsider.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(itemsRouter.versions, { id: randomUUID() }, { context: org.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("enforces the exported writer policy for agents and activates human writes", async () => {
    const org = await createOrg();
    const fact = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: org.orgScope.id,
      kind: "memory",
      title: "Agent fact",
      body: { type: "fact", content: "A low-stakes fact" },
      status: "proposed",
    });
    const rule = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: org.orgScope.id,
      kind: "memory",
      title: "Agent rule",
      body: { type: "rule", content: "Never push to main" },
      status: "active",
    });
    const instruction = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.agent.id,
      scopeId: org.orgScope.id,
      kind: "instruction",
      title: "Agent instruction",
      body: { content: "Use concise summaries" },
      status: "active",
    });
    const humanRule = await createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: org.orgScope.id,
      kind: "memory",
      title: "Human rule",
      body: { type: "rule", content: "Open a pull request" },
      status: "proposed",
    });

    expect(fact.status).toBe(agentWritePolicy.memory.fact);
    expect(rule.status).toBe(agentWritePolicy.memory.rule);
    expect(instruction.status).toBe(agentWritePolicy.instruction.default);
    expect(humanRule.status).toBe("active");
  });

  it("rejects later-phase kinds and malformed memory bodies", async () => {
    const org = await createOrg();
    for (const kind of ["skill", "connector", "conversation"] as const) {
      await expect(
        call(
          itemsRouter.create,
          {
            scopeId: org.orgScope.id,
            kind,
            title: `Future ${kind}`,
            body: { content: "Not available yet" },
          },
          { context: org.context },
        ),
      ).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: expect.stringContaining("arrives in a later phase"),
      });
    }
    await expect(
      call(
        itemsRouter.create,
        {
          scopeId: org.orgScope.id,
          kind: "memory",
          title: "Malformed",
          body: { type: "opinion", content: "Unknown memory type" },
        },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST", message: expect.stringContaining("memory") });
  });

  it("filters by kind, status, and scope without leaking across organizations", async () => {
    const orgA = await createOrg("Organization A");
    const shared = await call(
      scopesRouter.create,
      { name: "Engineering" },
      { context: orgA.context },
    );
    const orgFact = await createMemory(orgA, { title: "Org fact" });
    const sharedRule = await createMemory(orgA, {
      title: "Shared rule",
      type: "rule",
      scopeId: shared.id,
    });
    const proposed = await createItem(db, {
      orgId: orgA.org.id,
      actorPrincipalId: orgA.agent.id,
      scopeId: shared.id,
      kind: "instruction",
      title: "Proposed instruction",
      body: { content: "Use the runbook" },
    });
    const orgB = await createOrg("Organization B");
    const foreign = await createMemory(orgB, { title: "Foreign fact" });

    await expect(
      call(itemsRouter.list, { kind: "memory" }, { context: orgA.context }),
    ).resolves.toEqual(expect.arrayContaining([expect.objectContaining({ id: orgFact.id })]));
    const sharedItems = await call(
      itemsRouter.list,
      { scopeId: shared.id },
      { context: orgA.context },
    );
    expect(sharedItems.map(({ id }) => id)).toEqual([sharedRule.id, proposed.id]);
    await expect(
      call(itemsRouter.list, { status: "proposed" }, { context: orgA.context }),
    ).resolves.toEqual([expect.objectContaining({ id: proposed.id })]);
    const allA = await call(itemsRouter.list, {}, { context: orgA.context });
    expect(allA.map(({ id }) => id)).not.toContain(foreign.id);
    await expect(
      call(itemsRouter.get, { id: foreign.id }, { context: orgA.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("applies every disclosure default and honors an explicit override", async () => {
    const org = await createOrg();
    for (const type of ["fact", "preference", "rule", "procedure"] as const) {
      const item = await createMemory(org, { title: `Default ${type}`, type });
      expect(item.disclosure).toBe(disclosureDefaults.memory[type]);
    }
    const instruction = await call(
      itemsRouter.create,
      {
        scopeId: org.orgScope.id,
        kind: "instruction",
        title: "Default instruction",
        body: { content: "Keep this standing" },
      },
      { context: org.context },
    );
    expect(instruction.disclosure).toBe(disclosureDefaults.instruction.default);

    const override = await createMemory(org, {
      title: "Pinned procedure",
      type: "procedure",
      disclosure: "standing",
    });
    expect(override.disclosure).toBe("standing");
  });

  it("writes an audit row for every mutation", async () => {
    const org = await createOrg();
    const item = await createMemory(org, { title: "Audited" });
    await call(
      itemsRouter.update,
      { id: item.id, disclosure: "standing" },
      { context: org.context },
    );
    await call(itemsRouter.archive, { id: item.id }, { context: org.context });
    await call(itemsRouter.restore, { id: item.id }, { context: org.context });

    const actions = await db.auditLog.findMany({
      where: { orgId: org.org.id, subject: item.id },
      orderBy: { createdAt: "asc" },
      select: { action: true },
    });
    expect(actions.map(({ action }) => action)).toEqual([
      "item.create",
      "item.update",
      "item.archive",
      "item.restore",
    ]);
  });
});
