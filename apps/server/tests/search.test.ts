import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { orgRouter } from "#/rpc/org.js";
import { scopesRouter } from "#/rpc/scopes.js";
import { searchRouter } from "#/rpc/search.js";
import { archiveItem, createItem } from "#/services/items/index.js";
import { ensurePersonalScope } from "#/services/scopes/index.js";
import { rebuildSearchIndex, searchItems } from "#/services/search/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";

const longContent = [
  "The deployment runbook lives in the operations handbook.",
  "It explains how the release train works, who signs off on a release,",
  "and which dashboards to watch while the rollout drains connections.",
  "Every paragraph here exists so the stored content is far longer than any",
  "excerpt the search route is allowed to return to a caller.",
  "The runbook also covers the rollback procedure, the paging rotation,",
  "and the checklist that closes out an incident review.",
].join(" ");

integration("item search", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "item-search-integration-secret-at-least-32-chars",
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

  async function createOrg(name = "Search Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    return { ...signedUp, ...membership, orgScope };
  }

  function createMemory(
    org: Awaited<ReturnType<typeof createOrg>>,
    input: { scopeId: string; title: string; content: string },
  ) {
    return createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: input.scopeId,
      kind: "memory",
      title: input.title,
      body: { type: "fact", content: input.content },
    });
  }

  it("returns matches only from the requested scopes", async () => {
    const org = await createOrg();
    const shared = await call(
      scopesRouter.create,
      { name: "Engineering" },
      { context: org.context },
    );
    const personal = await ensurePersonalScope(db, {
      orgId: org.org.id,
      principalId: org.principal.id,
      displayName: "Owner",
    });

    const orgItem = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Org note",
      content: "The kingfisher release ships on Tuesday",
    });
    const sharedItem = await createMemory(org, {
      scopeId: shared.id,
      title: "Shared note",
      content: "The kingfisher dashboard is owned by engineering",
    });
    const personalItem = await createMemory(org, {
      scopeId: personal.id,
      title: "Personal note",
      content: "My kingfisher checklist starts with the changelog",
    });

    const results = await searchItems(db, {
      orgId: org.org.id,
      scopeIds: [personal.id, org.orgScope.id],
      query: "kingfisher",
    });
    const ids = results.map(({ id }) => id);
    expect(ids).toContain(orgItem.id);
    expect(ids).toContain(personalItem.id);
    expect(ids).not.toContain(sharedItem.id);

    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [], query: "kingfisher" }),
    ).resolves.toEqual([]);
    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "   " }),
    ).resolves.toEqual([]);
  });

  it("returns a bounded excerpt and never the stored body", async () => {
    const org = await createOrg();
    await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Deployment runbook",
      content: longContent,
    });

    const results = await call(
      searchRouter.items,
      { query: "rollback procedure", scopeIds: [org.orgScope.id] },
      { context: org.context },
    );

    expect(results).toHaveLength(1);
    const [result] = results;
    if (!result) throw new Error("Expected a search result");
    expect(Object.keys(result).sort()).toEqual(["id", "kind", "score", "snippet", "title"]);
    expect(result.snippet.length).toBeLessThan(longContent.length);
    expect(JSON.stringify(results)).not.toContain(longContent);
    expect(result.snippet).toContain("rollback");
    expect(result.snippet).not.toContain("<b>");
  });

  it("restores searchability after the index is rebuilt", async () => {
    const org = await createOrg();
    await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Vault rotation",
      content: "Rotate the vault credentials every quarter",
    });

    await db.itemSearchDoc.deleteMany({});
    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "vault" }),
    ).resolves.toEqual([]);

    await rebuildSearchIndex(db, org.org.id);
    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "vault" }),
    ).resolves.toHaveLength(1);
  });

  it("drops archived items without an index write", async () => {
    const org = await createOrg();
    const item = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Pager rotation",
      content: "The pager rotation hands over on Monday",
    });
    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "pager" }),
    ).resolves.toHaveLength(1);

    await archiveItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      itemId: item.id,
    });

    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "pager" }),
    ).resolves.toEqual([]);
    await expect(db.itemSearchDoc.count({ where: { itemId: item.id } })).resolves.toBe(1);
  });

  it("ranks a title match above a body-only match", async () => {
    const org = await createOrg();
    const titled = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Onboarding checklist",
      content: "Read the handbook and meet the team",
    });
    const bodyOnly = await createMemory(org, {
      scopeId: org.orgScope.id,
      title: "Weekly rituals",
      content: "Mondays cover onboarding for anyone who joined last week",
    });

    const results = await searchItems(db, {
      orgId: org.org.id,
      scopeIds: [org.orgScope.id],
      query: "onboarding",
    });
    expect(results.map(({ id }) => id)).toEqual([titled.id, bodyOnly.id]);
    expect(results[0]!.score).toBeGreaterThan(results[1]!.score);
  });

  it("writes the item even when the index write fails", async () => {
    const org = await createOrg();
    await db.$executeRaw`ALTER TABLE "ItemSearchDoc" RENAME TO "ItemSearchDocOffline"`;
    let created: Awaited<ReturnType<typeof createMemory>>;
    try {
      created = await createMemory(org, {
        scopeId: org.orgScope.id,
        title: "Escalation path",
        content: "Escalate to the on-call lead after fifteen minutes",
      });
    } finally {
      await db.$executeRaw`ALTER TABLE "ItemSearchDocOffline" RENAME TO "ItemSearchDoc"`;
    }

    await expect(db.item.count({ where: { id: created.id } })).resolves.toBe(1);
    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "escalate" }),
    ).resolves.toEqual([]);

    await rebuildSearchIndex(db, org.org.id);
    await expect(
      searchItems(db, { orgId: org.org.id, scopeIds: [org.orgScope.id], query: "escalate" }),
    ).resolves.toHaveLength(1);
  });
});
