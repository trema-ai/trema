import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#server/generated/prisma/client.js";
import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { createLogger, withLogger } from "#server/lib/logger/index.js";
import { itemsRouter } from "#server/rpc/items.js";
import { orgRouter } from "#server/rpc/org.js";
import { searchRouter } from "#server/rpc/search.js";
import type { Embedder } from "#server/services/embeddings/index.js";
import { createItem, updateItem } from "#server/services/items/index.js";
import { putDefaults, putProvider } from "#server/services/model-providers/index.js";
import {
  backfillEmbeddings,
  rebuildSearchIndex,
  searchItems,
} from "#server/services/search/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 7).toString("base64");

// Three topics, one per dimension. Two texts land on the same unit vector when
// they draw on the same topic, however few words they share, which is exactly
// the case lexical search cannot answer.
const topics = [
  ["vacation", "holiday", "paid time off"],
  ["deploy", "release", "rollout"],
  ["invoice", "billing", "payment"],
];

function fakeVector(text: string): number[] {
  const lower = text.toLowerCase();
  const raw = topics.map((words) => words.filter((word) => lower.includes(word)).length);
  const magnitude = Math.hypot(...raw);
  // A zero vector has no direction, and cosine distance against one is not a
  // number, so unrelated text gets a small vector pointing away from every topic.
  return magnitude === 0 ? [0.01, 0.01, 0.01] : raw.map((value) => value / magnitude);
}

function fakeEmbedder(model = "fake-embedding-model"): Embedder {
  return { model, embed: async (texts) => texts.map(fakeVector) };
}

const failingEmbedder: Embedder = {
  model: "fake-embedding-model",
  embed: async () => {
    throw new Error("embedding endpoint unreachable");
  },
};

integration("item embeddings and hybrid search", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "item-embeddings-integration-secret-at-least-32",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
    TREMA_CREDENTIAL_MASTER_KEY: masterKey,
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

  async function createOrg(name = "Embedding Org") {
    const signedUp = await signUp(`${name} Owner`);
    const membership = await call(orgRouter.create, { name }, { context: signedUp.context });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: membership.org.id, kind: "org" },
    });
    return { ...signedUp, ...membership, orgScope };
  }

  async function addMember(orgId: string, scopeId: string, role: Role) {
    const member = await signUp("Embedding Member");
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: member.user.id,
        displayName: "Embedding Member",
        email: member.user.email,
      },
    });
    await db.grant.create({ data: { orgId, principalId: principal.id, scopeId, role } });
    await db.session.updateMany({
      where: { userId: member.user.id },
      data: { activeOrgId: orgId },
    });
    return { ...member, principal };
  }

  // The `embed` role and one provider row: the only way embeddings are
  // configured now that the registry owns model configuration.
  async function configure(orgId: string, model = "fake-embedding-model") {
    await putProvider(db, {
      orgId,
      name: "vectors",
      protocol: "openai_compatible",
      baseUrl: "https://embeddings.example.test/v1",
      credentialMode: "none",
    });
    await putDefaults(db, {
      orgId,
      role: "embed",
      chain: [{ providerName: "vectors", modelId: model }],
    });
  }

  function createMemory(
    org: Awaited<ReturnType<typeof createOrg>>,
    input: { title: string; content: string; embedder?: Embedder },
  ) {
    return createItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      scopeId: org.orgScope.id,
      kind: "memory",
      title: input.title,
      body: { type: "fact", content: input.content },
      masterKey,
      ...(input.embedder ? { embedder: input.embedder } : {}),
    });
  }

  // "Paid time off" and "holiday" share no token, so only a vector ranking
  // can connect them.
  const paraphrase = {
    title: "Paid time off",
    content: "Everyone accrues paid time off each month and carries it into the next quarter.",
  };
  const query = "holiday";

  it("finds a paraphrase only when the organization has embeddings configured", async () => {
    const withEmbeddings = await createOrg("Configured Org");
    await configure(withEmbeddings.org.id);
    const embedded = await createMemory(withEmbeddings, {
      ...paraphrase,
      embedder: fakeEmbedder(),
    });

    const hybrid = await searchItems(db, {
      orgId: withEmbeddings.org.id,
      scopeIds: [withEmbeddings.orgScope.id],
      query,
      embedder: fakeEmbedder(),
      masterKey,
    });
    expect(hybrid.map(({ id }) => id)).toContain(embedded.id);

    const plain = await createOrg("Unconfigured Org");
    const unembedded = await createMemory(plain, paraphrase);
    const lexical = await searchItems(db, {
      orgId: plain.org.id,
      scopeIds: [plain.orgScope.id],
      query,
      masterKey,
    });
    expect(lexical.map(({ id }) => id)).not.toContain(unembedded.id);
  });

  it("falls back to the lexical results when the endpoint cannot be reached", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    const lexicalHit = await createMemory(org, {
      title: "Holiday calendar",
      content: "The holiday calendar is published each January.",
      embedder: fakeEmbedder(),
    });
    const semanticHit = await createMemory(org, { ...paraphrase, embedder: fakeEmbedder() });

    const filters = { orgId: org.org.id, scopeIds: [org.orgScope.id], query, masterKey };
    const lexicalOnly = await searchItems(db, { ...filters, embedder: failingEmbedder });
    expect(lexicalOnly.map(({ id }) => id)).toEqual([lexicalHit.id]);

    const hybrid = await searchItems(db, { ...filters, embedder: fakeEmbedder() });
    expect(hybrid.map(({ id }) => id)).toEqual(
      expect.arrayContaining([lexicalHit.id, semanticHit.id]),
    );
  });

  it("writes the item and leaves the vector null when embedding fails", async () => {
    const org = await createOrg();
    await configure(org.org.id);

    const item = await createMemory(org, { ...paraphrase, embedder: failingEmbedder });

    await expect(db.item.count({ where: { id: item.id } })).resolves.toBe(1);
    const [row] = await db.$queryRaw<Array<{ embedded: boolean }>>`
      SELECT "embedding" IS NOT NULL AS embedded FROM "ItemSearchDoc" WHERE "itemId" = ${item.id}
    `;
    expect(row?.embedded).toBe(false);
  });

  it("ignores a vector from a model the organization no longer uses", async () => {
    const org = await createOrg();
    await configure(org.org.id, "model-a");
    const item = await createMemory(org, { ...paraphrase, embedder: fakeEmbedder("model-a") });

    await configure(org.org.id, "model-b");
    const filters = { orgId: org.org.id, scopeIds: [org.orgScope.id], query, masterKey };

    const stale = await searchItems(db, { ...filters, embedder: fakeEmbedder("model-b") });
    expect(stale.map(({ id }) => id)).not.toContain(item.id);

    await backfillEmbeddings(db, org.org.id, { embedder: fakeEmbedder("model-b"), masterKey });

    const refreshed = await searchItems(db, { ...filters, embedder: fakeEmbedder("model-b") });
    expect(refreshed.map(({ id }) => id)).toContain(item.id);
  });

  it("backfills missing and stale vectors and reports the counts", async () => {
    const org = await createOrg();
    const missing = await createMemory(org, paraphrase);
    await configure(org.org.id, "model-a");
    const stale = await createMemory(org, {
      title: "Release notes",
      content: "Each rollout gets release notes.",
      embedder: fakeEmbedder("model-a"),
    });
    await configure(org.org.id, "model-b");

    const lines: string[] = [];
    const logger = createLogger({ level: "info", write: (line) => lines.push(line) });
    const result = await withLogger(logger, () =>
      backfillEmbeddings(db, org.org.id, { embedder: fakeEmbedder("model-b"), masterKey }),
    );

    expect(result).toEqual({ embedded: 2, failed: 0 });
    expect(lines.join("\n")).toContain("Embedding backfill finished");
    expect(lines.join("\n")).toContain("embedded=2");
    const rows = await db.$queryRaw<Array<{ itemId: string; embeddingModel: string | null }>>`
      SELECT "itemId", "embeddingModel" FROM "ItemSearchDoc" WHERE "orgId" = ${org.org.id}
    `;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.embeddingModel === "model-b")).toBe(true);
    expect(rows.map(({ itemId }) => itemId).sort()).toEqual([missing.id, stale.id].sort());
  });

  it("does nothing when the organization has no endpoint", async () => {
    const org = await createOrg();
    await createMemory(org, paraphrase);

    await expect(
      backfillEmbeddings(db, org.org.id, { embedder: fakeEmbedder(), masterKey }),
    ).resolves.toEqual({ embedded: 0, failed: 0 });
  });

  it("keeps the reindex behind the model capability", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member");
    await configure(org.org.id);

    await expect(call(itemsRouter.reindex, {}, { context: member.context })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
  });

  it("rebuilds the text index and embeds through the reindex route", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    const item = await createMemory(org, paraphrase);
    await expect(
      searchItems(db, {
        orgId: org.org.id,
        scopeIds: [org.orgScope.id],
        query,
        embedder: fakeEmbedder(),
        masterKey,
      }),
    ).resolves.toEqual([]);

    await db.itemSearchDoc.deleteMany({ where: { orgId: org.org.id } });
    await call(itemsRouter.reindex, {}, { context: org.context });

    // The reindex builds the real client from the settings row, which points at
    // an endpoint no test can reach, so only the text index comes back.
    const [row] = await db.$queryRaw<Array<{ embedded: boolean }>>`
      SELECT "embedding" IS NOT NULL AS embedded FROM "ItemSearchDoc" WHERE "itemId" = ${item.id}
    `;
    expect(row?.embedded).toBe(false);
    await expect(
      searchItems(db, {
        orgId: org.org.id,
        scopeIds: [org.orgScope.id],
        query: "accrues",
        masterKey,
      }),
    ).resolves.toHaveLength(1);
  });

  it("finds a paraphrase through the search route once vectors exist", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    const item = await createMemory(org, paraphrase);
    await backfillEmbeddings(db, org.org.id, { embedder: fakeEmbedder(), masterKey });

    const results = await searchItems(db, {
      orgId: org.org.id,
      scopeIds: [org.orgScope.id],
      query,
      embedder: fakeEmbedder(),
      masterKey,
    });

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({ id: item.id, kind: "memory", title: paraphrase.title });
    // A vector-only hit still carries an excerpt, taken from the head of the body.
    expect(results[0]?.snippet).not.toBe("");
    expect(paraphrase.content).toContain(results[0]?.snippet ?? "");

    await expect(
      call(searchRouter.items, { query, scopeIds: [org.orgScope.id] }, { context: org.context }),
    ).resolves.toHaveLength(0);
  });

  function countVectors(orgId: string): Promise<number> {
    return db.$queryRaw<[{ count: number }]>`
        SELECT count(*)::int AS count FROM "ItemSearchDoc"
        WHERE "orgId" = ${orgId} AND "embedding" IS NOT NULL
      `.then(([row]) => row?.count ?? 0);
  }

  it("clears the stored vector when the text changes and the embed fails", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    const item = await createMemory(org, { ...paraphrase, embedder: fakeEmbedder() });
    await expect(countVectors(org.org.id)).resolves.toBe(1);

    await updateItem(db, {
      orgId: org.org.id,
      actorPrincipalId: org.principal.id,
      itemId: item.id,
      body: { type: "fact", content: "Vacation balances reset at the end of the year." },
      masterKey,
      embedder: failingEmbedder,
    });

    // The old vector must not outlive the text it described.
    await expect(countVectors(org.org.id)).resolves.toBe(0);

    await backfillEmbeddings(db, org.org.id, { embedder: fakeEmbedder() });
    await expect(countVectors(org.org.id)).resolves.toBe(1);
  });

  it("refuses to reindex when the embed role names a provider that is gone", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    await createMemory(org, { ...paraphrase, embedder: fakeEmbedder() });

    // A role default outlives the provider it names, by design: that is what
    // makes a fallback chain a chain. With nothing left to fall back to, an
    // explicit reindex must say so rather than quietly embedding nothing.
    await db.modelProvider.deleteMany({ where: { orgId: org.org.id } });

    await expect(call(itemsRouter.reindex, {}, { context: org.context })).rejects.toThrow(
      /no usable provider/i,
    );
    await expect(countVectors(org.org.id)).resolves.toBe(1);

    // An organization that never configured embeddings is a different case: it
    // reindexes its text and reports an honest zero.
    const plain = await createOrg("Unconfigured Reindex Org");
    await expect(call(itemsRouter.reindex, {}, { context: plain.context })).resolves.toEqual({
      embedded: 0,
      failed: 0,
    });
  });

  it("leaves vectors intact when reindex cannot build the embedder", async () => {
    const org = await createOrg();
    await putProvider(db, {
      orgId: org.org.id,
      name: "vectors",
      protocol: "openai_compatible",
      baseUrl: "https://embeddings.example.test/v1",
      credential: "sk-test",
      masterKey,
    });
    await putDefaults(db, {
      orgId: org.org.id,
      role: "embed",
      chain: [{ providerName: "vectors", modelId: "fake-embedding-model" }],
    });
    await createMemory(org, { ...paraphrase, embedder: fakeEmbedder() });
    await expect(countVectors(org.org.id)).resolves.toBe(1);

    const envWithoutKey = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      TREMA_AUTH_SECRET: "item-embeddings-integration-secret-at-least-32",
      TREMA_MODE: "hosted",
      TREMA_WEB_ORIGINS: "https://trema.example",
    });
    await expect(
      call(itemsRouter.reindex, {}, { context: { ...org.context, env: envWithoutKey } }),
    ).rejects.toThrow(/credential master key/i);

    // The failed reindex must not have wiped the index or its vectors.
    await expect(countVectors(org.org.id)).resolves.toBe(1);
  });

  it("stops the backfill when the settings disappear mid-run", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    // One more item than the batch size, so the run needs a second batch.
    for (let index = 0; index < 33; index += 1) {
      await createMemory(org, {
        title: `Deploy note ${String(index).padStart(2, "0")}`,
        content: "Deploy notes for the rollout.",
        embedder: failingEmbedder,
      });
    }

    const deletingEmbedder: Embedder = {
      model: "fake-embedding-model",
      embed: async (texts) => {
        await db.modelDefault.deleteMany({ where: { orgId: org.org.id, role: "embed" } });
        return texts.map(fakeVector);
      },
    };

    // The first batch embeds and then unassigns the role; the re-resolution
    // before the second batch sees no embed default and ends the run.
    const result = await backfillEmbeddings(db, org.org.id, { embedder: deletingEmbedder });
    expect(result).toEqual({ embedded: 32, failed: 0 });
    await expect(countVectors(org.org.id)).resolves.toBe(32);
  });

  it("rescans rows embedded earlier in the run when the model changes", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    for (let index = 0; index < 33; index += 1) {
      await createMemory(org, {
        title: `Deploy note ${String(index).padStart(2, "0")}`,
        content: "Deploy notes for the rollout.",
        embedder: failingEmbedder,
      });
    }

    // The first batch runs as model-a; every later batch reports model-b, so
    // the rows the first batch wrote are stale again and must be rescanned.
    let embedCalls = 0;
    const switchingEmbedder: Embedder = {
      get model() {
        return embedCalls === 0 ? "model-a" : "model-b";
      },
      embed: async (texts) => {
        embedCalls += 1;
        return texts.map(fakeVector);
      },
    };

    // 32 rows as model-a, then the 32 rescanned rows as model-b, then the one
    // row the first pass never reached.
    const result = await backfillEmbeddings(db, org.org.id, { embedder: switchingEmbedder });
    expect(result).toEqual({ embedded: 65, failed: 0 });

    const [staleRows] = await db.$queryRaw<[{ count: number }]>`
      SELECT count(*)::int AS count FROM "ItemSearchDoc"
      WHERE "orgId" = ${org.org.id} AND "embeddingModel" IS DISTINCT FROM 'model-b'
    `;
    expect(staleRows?.count).toBe(0);
  });

  it("keeps vectors for unchanged items through a rebuild", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    await createMemory(org, { ...paraphrase, embedder: fakeEmbedder() });
    await expect(countVectors(org.org.id)).resolves.toBe(1);

    // The rebuild reconciles the text; unchanged text keeps its vector even
    // though no embedding endpoint is reachable here.
    await rebuildSearchIndex(db, org.org.id);
    await expect(countVectors(org.org.id)).resolves.toBe(1);
  });

  it("leaves the vector cleared when the item changes during the backfill", async () => {
    const org = await createOrg();
    await configure(org.org.id);
    await createMemory(org, { ...paraphrase, embedder: failingEmbedder });

    // The edit lands between the batch read and the vector write, the same
    // window a concurrent item update occupies.
    const editingEmbedder: Embedder = {
      model: "fake-embedding-model",
      embed: async (texts) => {
        await db.itemSearchDoc.updateMany({
          where: { orgId: org.org.id },
          data: { content: "Edited while the batch was embedding." },
        });
        return texts.map(fakeVector);
      },
    };

    const result = await backfillEmbeddings(db, org.org.id, { embedder: editingEmbedder });
    expect(result).toEqual({ embedded: 0, failed: 1 });
    await expect(countVectors(org.org.id)).resolves.toBe(0);
  });
});
