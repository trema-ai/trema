import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import type { Role } from "#/generated/prisma/client.js";
import { createAuth } from "#/lib/auth/index.js";
import { createPrismaClient } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";
import { createLogger, withLogger } from "#/lib/logger/index.js";
import { embeddingsRouter } from "#/rpc/embeddings.js";
import { orgRouter } from "#/rpc/org.js";
import { searchRouter } from "#/rpc/search.js";
import type { Embedder } from "#/services/embeddings/index.js";
import { createItem } from "#/services/items/index.js";
import { backfillEmbeddings, searchItems } from "#/services/search/index.js";

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

  function configure(orgId: string, model = "fake-embedding-model") {
    return db.embeddingSettings.create({
      data: { orgId, endpoint: "https://embeddings.example.test/v1", model },
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

    await db.embeddingSettings.update({
      where: { orgId: org.org.id },
      data: { model: "model-b" },
    });
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
    await db.embeddingSettings.update({
      where: { orgId: org.org.id },
      data: { model: "model-b" },
    });

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

  it("round-trips the settings without ever returning the key", async () => {
    const org = await createOrg();
    const apiKey = "sk-embedding-super-secret";

    const stored = await call(
      embeddingsRouter.settings.put,
      { endpoint: "https://api.openai.example/v1/", model: "text-embedding-3-small", apiKey },
      { context: org.context },
    );
    const fetched = await call(embeddingsRouter.settings.get, {}, { context: org.context });

    expect(stored).toMatchObject({
      configured: true,
      endpoint: "https://api.openai.example/v1",
      model: "text-embedding-3-small",
      hasApiKey: true,
    });
    expect(fetched).toMatchObject({ configured: true, hasApiKey: true });
    expect(JSON.stringify([stored, fetched])).not.toContain(apiKey);

    const persisted = await db.embeddingSettings.findUniqueOrThrow({
      where: { orgId: org.org.id },
    });
    expect(persisted.apiKeyCiphertext).not.toContain(apiKey);

    // Omitting the key keeps the stored one; null clears it for a local endpoint.
    await call(
      embeddingsRouter.settings.put,
      { endpoint: "http://127.0.0.1:8080/v1", model: "bge-small" },
      { context: org.context },
    );
    await expect(
      call(embeddingsRouter.settings.get, {}, { context: org.context }),
    ).resolves.toMatchObject({ hasApiKey: true });

    await call(
      embeddingsRouter.settings.put,
      { endpoint: "http://127.0.0.1:8080/v1", model: "bge-small", apiKey: null },
      { context: org.context },
    );
    await expect(
      call(embeddingsRouter.settings.get, {}, { context: org.context }),
    ).resolves.toMatchObject({ hasApiKey: false });
  });

  it("reports an unconfigured organization instead of failing", async () => {
    const org = await createOrg();

    await expect(
      call(embeddingsRouter.settings.get, {}, { context: org.context }),
    ).resolves.toEqual({
      configured: false,
      endpoint: null,
      model: null,
      hasApiKey: false,
      updatedAt: null,
    });
    await expect(
      call(embeddingsRouter.settings.delete, {}, { context: org.context }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps the settings and the reindex behind the model capability", async () => {
    const org = await createOrg();
    const member = await addMember(org.org.id, org.orgScope.id, "member");
    await configure(org.org.id);

    await expect(
      call(embeddingsRouter.settings.get, {}, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(embeddingsRouter.reindex, {}, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(embeddingsRouter.settings.delete, {}, { context: member.context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        embeddingsRouter.settings.put,
        { endpoint: "https://api.openai.example/v1", model: "text-embedding-3-small" },
        { context: member.context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("rejects an endpoint that is not an absolute http URL", async () => {
    const org = await createOrg();

    await expect(
      call(
        embeddingsRouter.settings.put,
        { endpoint: "ftp://files.example/v1", model: "text-embedding-3-small" },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
    await expect(
      call(
        embeddingsRouter.settings.put,
        { endpoint: "not-a-url", model: "text-embedding-3-small" },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
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
    await call(embeddingsRouter.reindex, {}, { context: org.context });

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
});
