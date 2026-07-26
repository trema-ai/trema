import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { type Environment, parseEnv } from "#server/lib/env/schema.js";
import { modelProvidersRouter } from "#server/rpc/model-providers.js";
import { orgRouter } from "#server/rpc/org.js";
import { resolveEmbedder } from "#server/services/embeddings/index.js";
import {
  resolveEndpoints,
  resolveRoleModel,
  seedModelProvidersFromEnv,
} from "#server/services/model-providers/index.js";
import { ModelConfigurationError, resolveConfiguredModel } from "#server/services/runs/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 5).toString("base64");

// The environment a deployment configured before the registry existed. The
// cutover test proves a registry seeded from this produces the same descriptors
// the old parse produced, byte for byte.
const legacyEndpoints = {
  primary: {
    protocol: "openai-compatible",
    baseUrl: "https://models.example.test/v1",
    apiKey: "primary-secret",
    headers: { "x-tenant": "acme" },
  },
  secondary: {
    protocol: "openai-compatible",
    baseUrl: "https://fallback.example.test/v1",
    apiKey: "secondary-secret",
  },
};

integration("model provider registry", () => {
  const db = createPrismaClient(databaseUrl);
  const baseEnv = {
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "model-providers-integration-secret-at-least-32",
    TREMA_MODE: "hosted",
    TREMA_WEB_ORIGINS: "https://trema.example",
    TREMA_CREDENTIAL_MASTER_KEY: masterKey,
  };
  const env = parseEnv(baseEnv);
  const auth = createAuth({ db, env });

  function envWith(extra: Record<string, string>): Environment {
    return parseEnv({ ...baseEnv, ...extra });
  }

  beforeEach(async () => {
    await db.$executeRaw`TRUNCATE TABLE "Org", "user", "verification", "BootstrapToken" CASCADE`;
  });

  afterAll(async () => {
    await db.$disconnect();
  });

  async function createOrg(name = "Registry Org") {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: `${name} Owner`, email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const context = { db, auth, env, headers: new Headers({ cookie }) };
    const membership = await call(orgRouter.create, { name }, { context });
    return { ...membership, context };
  }

  const openAiCompatible = {
    protocol: "openai_compatible",
    baseUrl: "https://models.example.test/v1",
  } as const;

  it("stores a provider and reports its credential as status only", async () => {
    const org = await createOrg();

    const created = await call(
      modelProvidersRouter.providers.put,
      { ...openAiCompatible, name: "primary", label: "Primary", credential: "the-secret" },
      { context: org.context },
    );
    expect(created).toMatchObject({
      name: "primary",
      label: "Primary",
      protocol: "openai_compatible",
      credentialMode: "api_key",
      hasCredential: true,
    });
    expect(JSON.stringify(created)).not.toContain("the-secret");

    const listed = await call(modelProvidersRouter.providers.list, {}, { context: org.context });
    expect(listed).toHaveLength(1);
    expect(JSON.stringify(listed)).not.toContain("the-secret");

    // An omitted credential keeps the stored one, so editing a base URL does
    // not cost the admin a key rotation.
    const edited = await call(
      modelProvidersRouter.providers.put,
      { ...openAiCompatible, name: "primary", baseUrl: "https://moved.example.test/v1" },
      { context: org.context },
    );
    expect(edited).toMatchObject({ baseUrl: "https://moved.example.test/v1", hasCredential: true });

    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.primary).toEqual({
      protocol: "openai-compatible",
      baseUrl: "https://moved.example.test/v1",
      apiKey: "the-secret",
    });
  });

  it("refuses a provider that cannot authenticate and one with an unusable base URL", async () => {
    const org = await createOrg();

    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name: "keyless" },
        { context: org.context },
      ),
    ).rejects.toThrow(/needs a credential/);

    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name: "local", baseUrl: "not-a-url", credentialMode: "none" },
        { context: org.context },
      ),
    ).rejects.toThrow(/absolute URL/);
  });

  it("serves an endpoint that needs no credential", async () => {
    const org = await createOrg();

    const created = await call(
      modelProvidersRouter.providers.put,
      {
        name: "local",
        protocol: "openai_compatible",
        baseUrl: "http://localhost:11434/v1",
        credentialMode: "none",
      },
      { context: org.context },
    );
    expect(created).toMatchObject({ credentialMode: "none", hasCredential: false });

    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.local).toEqual({
      protocol: "openai-compatible",
      baseUrl: "http://localhost:11434/v1",
    });
  });

  it("resolves a role through its fallback chain and past a deleted provider", async () => {
    const org = await createOrg();
    for (const name of ["primary", "secondary"]) {
      await call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name, credential: `${name}-secret` },
        { context: org.context },
      );
    }

    await expect(
      call(
        modelProvidersRouter.defaults.put,
        { role: "turns", chain: [{ providerName: "absent", modelId: "m" }] },
        { context: org.context },
      ),
    ).rejects.toThrow(/no such provider/);

    await call(
      modelProvidersRouter.defaults.put,
      {
        role: "turns",
        chain: [
          { providerName: "primary", modelId: "big-model" },
          { providerName: "secondary", modelId: "small-model" },
        ],
      },
      { context: org.context },
    );
    expect(await resolveRoleModel(db, org.org.id, "turns")).toEqual({
      providerName: "primary",
      modelId: "big-model",
    });

    // Deleting a provider degrades the chain rather than breaking it.
    await call(
      modelProvidersRouter.providers.delete,
      { name: "primary" },
      { context: org.context },
    );
    expect(await resolveRoleModel(db, org.org.id, "turns")).toEqual({
      providerName: "secondary",
      modelId: "small-model",
    });
  });

  it("builds the run loop's model from the registry, and says so when it cannot", async () => {
    const org = await createOrg();

    await expect(resolveConfiguredModel(db, org.org.id, { masterKey })).rejects.toBeInstanceOf(
      ModelConfigurationError,
    );

    await call(
      modelProvidersRouter.providers.put,
      { ...openAiCompatible, name: "primary", credential: "primary-secret" },
      { context: org.context },
    );
    // A provider without a turns assignment is still not a runnable deployment.
    await expect(resolveConfiguredModel(db, org.org.id, { masterKey })).rejects.toThrow(
      /turns role/,
    );

    await call(
      modelProvidersRouter.defaults.put,
      { role: "turns", chain: [{ providerName: "primary", modelId: "big-model" }] },
      { context: org.context },
    );
    const configured = await resolveConfiguredModel(db, org.org.id, { masterKey });
    expect(configured.model).toEqual({ id: "big-model", provider: "primary" });
    expect(configured.modelPort).toBeDefined();
  });

  it("seeds an empty registry from the environment and produces the descriptors the env parse did", async () => {
    const org = await createOrg();
    const seeded = envWith({
      TREMA_MODEL_ENDPOINTS: JSON.stringify(legacyEndpoints),
      TREMA_MODEL_ID: "big-model",
      TREMA_MODEL_PROVIDER: "primary",
    });

    await seedModelProvidersFromEnv(db, seeded, org.org.id);

    // The descriptor map the deleted `parseModelEndpoints` would have built.
    expect(await resolveEndpoints(db, org.org.id, { masterKey })).toEqual({
      primary: {
        protocol: "openai-compatible",
        baseUrl: "https://models.example.test/v1",
        apiKey: "primary-secret",
        headers: { "x-tenant": "acme" },
      },
      secondary: {
        protocol: "openai-compatible",
        baseUrl: "https://fallback.example.test/v1",
        apiKey: "secondary-secret",
      },
    });

    const configured = await resolveConfiguredModel(db, org.org.id, { masterKey });
    expect(configured.model).toEqual({ id: "big-model", provider: "primary" });
  });

  it("ignores the environment once the registry has a row", async () => {
    const org = await createOrg();
    await call(
      modelProvidersRouter.providers.put,
      { ...openAiCompatible, name: "chosen", credential: "chosen-secret" },
      { context: org.context },
    );

    await seedModelProvidersFromEnv(
      db,
      envWith({
        TREMA_MODEL_ENDPOINTS: JSON.stringify(legacyEndpoints),
        TREMA_MODEL_ID: "big-model",
        TREMA_MODEL_PROVIDER: "primary",
      }),
      org.org.id,
    );

    expect(Object.keys(await resolveEndpoints(db, org.org.id, { masterKey }))).toEqual(["chosen"]);
  });

  it("reports which headers are set without returning their values", async () => {
    const org = await createOrg();

    const created = await call(
      modelProvidersRouter.providers.put,
      {
        ...openAiCompatible,
        name: "primary",
        credential: "the-secret",
        headers: { authorization: "Bearer header-token", "x-tenant": "acme" },
      },
      { context: org.context },
    );
    // A header is a place to hide a token, so values get the credential's
    // treatment rather than being echoed to every manage_models caller.
    expect(created.headerNames).toEqual(["authorization", "x-tenant"]);
    expect(JSON.stringify(created)).not.toContain("header-token");

    const listed = await call(modelProvidersRouter.providers.list, {}, { context: org.context });
    expect(JSON.stringify(listed)).not.toContain("header-token");

    // Stored in full, though: the resolver still sends them.
    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.primary).toMatchObject({
      headers: { authorization: "Bearer header-token", "x-tenant": "acme" },
    });
  });

  it("skips a provider it cannot read and falls through to the next chain entry", async () => {
    const org = await createOrg();
    for (const name of ["primary", "secondary"]) {
      await call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name, credential: `${name}-secret` },
        { context: org.context },
      );
    }
    await call(
      modelProvidersRouter.defaults.put,
      {
        role: "turns",
        chain: [
          { providerName: "primary", modelId: "big-model" },
          { providerName: "secondary", modelId: "small-model" },
        ],
      },
      { context: org.context },
    );

    // What a master-key rotation leaves behind on a row nobody re-entered.
    await db.modelProvider.update({
      where: { orgId_name: { orgId: org.org.id, name: "primary" } },
      data: { credentialCiphertext: "not-an-envelope" },
    });

    expect(Object.keys(await resolveEndpoints(db, org.org.id, { masterKey }))).toEqual([
      "secondary",
    ]);
    const configured = await resolveConfiguredModel(db, org.org.id, { masterKey });
    expect(configured.model).toEqual({ id: "small-model", provider: "secondary" });
  });

  it("leaves the registry empty when one seeded endpoint is unusable", async () => {
    const org = await createOrg();

    await seedModelProvidersFromEnv(
      db,
      envWith({
        TREMA_MODEL_ENDPOINTS: JSON.stringify({
          ...legacyEndpoints,
          // A valid URL that is not an endpoint the resolver can call.
          broken: {
            protocol: "openai-compatible",
            baseUrl: "ftp://models.example.test/v1",
            apiKey: "broken-secret",
          },
        }),
        TREMA_MODEL_ID: "big-model",
        TREMA_MODEL_PROVIDER: "primary",
      }),
      org.org.id,
    );

    // All or nothing: a partial registry would read as configured on the next
    // boot and strand the deployment with a subset of its providers.
    expect(await db.modelProvider.count({ where: { orgId: org.org.id } })).toBe(0);
    await expect(resolveConfiguredModel(db, org.org.id, { masterKey })).rejects.toBeInstanceOf(
      ModelConfigurationError,
    );
  });

  it("drives the embedder from the embed role, whichever screen assigned it", async () => {
    const org = await createOrg();
    expect(await resolveEmbedder(db, org.org.id, { masterKey })).toBeUndefined();

    await call(
      modelProvidersRouter.providers.put,
      {
        name: "vectors",
        protocol: "openai_compatible",
        baseUrl: "https://embeddings.example.test/v1",
        credential: "vectors-secret",
      },
      { context: org.context },
    );
    await call(
      modelProvidersRouter.defaults.put,
      { role: "embed", chain: [{ providerName: "vectors", modelId: "text-embedding-3-small" }] },
      { context: org.context },
    );

    // The embeddings screen and the Models screen are now the same two rows,
    // so search picks this up without the settings screen ever being opened.
    const embedder = await resolveEmbedder(db, org.org.id, { masterKey });
    expect(embedder?.model).toBe("text-embedding-3-small");
  });

  it("reports a stored credential the server has no master key to read", async () => {
    const org = await createOrg();
    const envWithoutKey = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: databaseUrl,
      TREMA_AUTH_SECRET: "model-providers-integration-secret-at-least-32",
      TREMA_MODE: "hosted",
      TREMA_WEB_ORIGINS: "https://trema.example",
    });

    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name: "primary", credential: "primary-secret" },
        { context: { ...org.context, env: envWithoutKey } },
      ),
    ).rejects.toThrow(/credential master key/i);
  });

  it("keeps the registry behind the model capability", async () => {
    const owner = await createOrg();
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "Registry Member", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const principal = await db.principal.create({
      data: {
        orgId: owner.org.id,
        kind: "human",
        authId: user.id,
        displayName: "Registry Member",
        email: user.email,
      },
    });
    const orgScope = await db.scope.findFirstOrThrow({
      where: { orgId: owner.org.id, kind: "org" },
    });
    await db.grant.create({
      data: {
        orgId: owner.org.id,
        principalId: principal.id,
        scopeId: orgScope.id,
        role: "member",
      },
    });
    await db.session.updateMany({
      where: { userId: user.id },
      data: { activeOrgId: owner.org.id },
    });
    const context = { db, auth, env, headers: new Headers({ cookie }) };

    await expect(call(modelProvidersRouter.providers.list, {}, { context })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(call(modelProvidersRouter.defaults.list, {}, { context })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name: "primary", credential: "primary-secret" },
        { context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("keeps one organization's providers out of another's", async () => {
    const first = await createOrg("First Org");
    const second = await createOrg("Second Org");
    await call(
      modelProvidersRouter.providers.put,
      { ...openAiCompatible, name: "primary", credential: "first-secret" },
      { context: first.context },
    );

    expect(
      await call(modelProvidersRouter.providers.list, {}, { context: second.context }),
    ).toEqual([]);
    await expect(
      call(modelProvidersRouter.providers.get, { name: "primary" }, { context: second.context }),
    ).rejects.toThrow(/not found/);
  });
});
