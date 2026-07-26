import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { type Environment, parseEnv } from "#server/lib/env/schema.js";
import { modelProvidersRouter } from "#server/rpc/model-providers.js";
import { orgRouter } from "#server/rpc/org.js";
import { resolveEmbedder } from "#server/services/embeddings/index.js";
import {
  putProvider,
  resolveEndpoints,
  resolveRoleModel,
  seedModelProvidersFromEnv,
} from "#server/services/model-providers/index.js";
import { probeProvider } from "#server/services/model-providers/remote.js";
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

  it("normalizes a base URL and refuses one a request path cannot be appended to", async () => {
    const org = await createOrg();

    // Every caller builds `${baseUrl}/models`, so a query or fragment would end
    // up in the middle of the path.
    for (const baseUrl of [
      "https://models.example.test/v1?tenant=acme",
      "https://models.example.test/v1#anchor",
    ]) {
      await expect(
        call(
          modelProvidersRouter.providers.put,
          { ...openAiCompatible, name: "primary", baseUrl, credential: "the-secret" },
          { context: org.context },
        ),
      ).rejects.toThrow(/query or fragment/);
    }

    // The base URL is read back in full, so it must not be a place a secret can live.
    await expect(
      call(
        modelProvidersRouter.providers.put,
        {
          ...openAiCompatible,
          name: "primary",
          baseUrl: "https://user:secret-token@models.example.test/v1",
          credential: "the-secret",
        },
        { context: org.context },
      ),
    ).rejects.toThrow(/cannot carry credentials/);

    const trimmed = await call(
      modelProvidersRouter.providers.put,
      {
        ...openAiCompatible,
        name: "primary",
        baseUrl: "https://models.example.test/v1//",
        credential: "the-secret",
      },
      { context: org.context },
    );
    expect(trimmed.baseUrl).toBe("https://models.example.test/v1");

    // A model server on the same host is plain http, and stays allowed.
    const local = await call(
      modelProvidersRouter.providers.put,
      {
        name: "local",
        protocol: "openai_compatible",
        baseUrl: "http://localhost:11434/v1/",
        credentialMode: "none",
      },
      { context: org.context },
    );
    expect(local.baseUrl).toBe("http://localhost:11434/v1");
  });

  it("refuses to create a provider whose name is taken, credential and all", async () => {
    const org = await createOrg();

    const created = await call(
      modelProvidersRouter.providers.create,
      { ...openAiCompatible, name: "primary", label: "First", credential: "first-secret" },
      { context: org.context },
    );
    expect(created).toMatchObject({ name: "primary", label: "First" });

    // The unique index answers, not a read: two admins creating the same
    // provider at once cannot both believe they won.
    await expect(
      call(
        modelProvidersRouter.providers.create,
        { ...openAiCompatible, name: "primary", label: "Second", credential: "second-secret" },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "CONFLICT" });

    const kept = await call(
      modelProvidersRouter.providers.get,
      { name: "primary" },
      { context: org.context },
    );
    expect(kept.label).toBe("First");
    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.primary).toMatchObject({ apiKey: "first-secret" });
  });

  it("refuses a catalog that lists one model twice", async () => {
    const org = await createOrg();

    await expect(
      call(
        modelProvidersRouter.providers.put,
        {
          ...openAiCompatible,
          name: "primary",
          credential: "the-secret",
          catalog: [{ id: "big-model" }, { id: "big-model", label: "Big model" }],
        },
        { context: org.context },
      ),
    ).rejects.toThrow(/big-model twice/);
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
    await expect(call(modelProvidersRouter.presets.list, {}, { context })).rejects.toMatchObject({
      code: "FORBIDDEN",
    });
    await expect(
      call(modelProvidersRouter.providers.probe, { name: "primary" }, { context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(modelProvidersRouter.providers.remoteModels, { name: "primary" }, { context }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        modelProvidersRouter.providers.create,
        { ...openAiCompatible, name: "primary", credential: "primary-secret" },
        { context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name: "primary", credential: "primary-secret" },
        { context },
      ),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("offers presets a provider can be created from", async () => {
    const org = await createOrg();
    const presets = await call(modelProvidersRouter.presets.list, {}, { context: org.context });

    expect(presets.length).toBeGreaterThan(0);
    for (const preset of presets) {
      expect(preset.protocol).toBe("openai_compatible");
      const parsed = new URL(preset.baseUrl);
      // Presets are stored verbatim, so they carry the normalized form a
      // request path can be appended to.
      expect(parsed.search).toBe("");
      expect(parsed.hash).toBe("");
      expect(preset.baseUrl.endsWith("/")).toBe(false);
    }
    // The screen needs both shapes: a keyed vendor and an endpoint on the host.
    expect(presets.some((preset) => preset.credentialMode === "api_key")).toBe(true);
    expect(presets.some((preset) => preset.credentialMode === "none")).toBe(true);
    // A vendor whose listing filters its own catalog ships the query that
    // undoes the filter, so an admin never has to know about it.
    expect(presets.some((preset) => preset.listQuery !== undefined)).toBe(true);
    for (const preset of presets) {
      for (const value of Object.values(preset.listQuery ?? {})) {
        expect(typeof value).toBe("string");
      }
    }

    // A preset is data the API hands over, so storing one is an ordinary create.
    // It brings no models: those are read from the provider afterwards.
    const preset = presets[0];
    if (!preset) throw new Error("A preset is required");
    const created = await call(
      modelProvidersRouter.providers.create,
      {
        name: preset.name,
        label: preset.label,
        protocol: preset.protocol,
        baseUrl: preset.baseUrl,
        credentialMode: preset.credentialMode,
        credential: preset.credentialMode === "api_key" ? "preset-secret" : null,
      },
      { context: org.context },
    );
    expect(created).toMatchObject({ name: preset.name, baseUrl: preset.baseUrl });
    expect(created.catalog).toEqual([]);
  });

  describe("health probe", () => {
    /** A stand-in provider on the loopback interface, so no test reaches a vendor. */
    async function startProvider(
      handler: (request: IncomingMessage, response: ServerResponse) => void,
    ) {
      const server = createServer(handler);
      await new Promise<void>((resolve) => {
        server.listen(0, "127.0.0.1", resolve);
      });
      const { port } = server.address() as AddressInfo;
      return {
        baseUrl: `http://127.0.0.1:${port}/v1`,
        async close() {
          server.closeAllConnections();
          await new Promise<void>((resolve) => {
            server.close(() => resolve());
          });
        },
      };
    }

    it("reports a reachable provider, the models it lists, and the credential it accepted", async () => {
      const seen: {
        path?: string | undefined;
        authorization?: string | undefined;
        tenant?: string | undefined;
      } = {};
      const provider = await startProvider((request, response) => {
        seen.path = request.url;
        seen.authorization = request.headers.authorization;
        seen.tenant = request.headers["x-tenant"] as string;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "big-model" }, { id: "small-model" }] }));
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
          headers: { "x-tenant": "acme" },
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.probe,
        { name: "primary" },
        { context: org.context },
      );
      expect(result).toMatchObject({ ok: true, modelCount: 2 });
      expect(seen.path).toBe("/v1/models");
      // The credential is spent on a header below the port and nowhere else.
      expect(seen.authorization).toBe("Bearer the-secret");
      expect(seen.tenant).toBe("acme");
      expect(JSON.stringify(result)).not.toContain("the-secret");

      await provider.close();
    });

    it("tells a rejected credential apart from an unreadable answer", async () => {
      const rejecting = await startProvider((_request, response) => {
        response.writeHead(401, { "content-type": "application/json" });
        response.end(JSON.stringify({ error: "invalid api key" }));
      });
      const babbling = await startProvider((_request, response) => {
        response.writeHead(200, { "content-type": "text/html" });
        response.end("<html>login</html>");
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "rejecting",
          protocol: "openai_compatible",
          baseUrl: rejecting.baseUrl,
          credential: "stale-secret",
        },
        { context: org.context },
      );
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "babbling",
          protocol: "openai_compatible",
          baseUrl: babbling.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      expect(
        await call(
          modelProvidersRouter.providers.probe,
          { name: "rejecting" },
          { context: org.context },
        ),
      ).toEqual({ ok: false, reason: "The provider rejected the credential (HTTP 401)." });
      expect(
        await call(
          modelProvidersRouter.providers.probe,
          { name: "babbling" },
          { context: org.context },
        ),
      ).toMatchObject({ ok: false, reason: expect.stringContaining("other than JSON") });

      await rejecting.close();
      await babbling.close();
    });

    it("reports an endpoint that never answers and one that is not listening", async () => {
      const silent = await startProvider(() => {
        // Never responds: what a hung endpoint looks like from the screen.
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "silent",
          protocol: "openai_compatible",
          baseUrl: silent.baseUrl,
          credentialMode: "none",
        },
        { context: org.context },
      );
      // The bound timeout is the RPC's; the service takes one so a test does
      // not have to wait it out.
      const timedOut = await probeProvider(db, org.org.id, "silent", {
        masterKey,
        timeoutMs: 250,
      });
      expect(timedOut).toEqual({
        ok: false,
        reason: "The provider did not answer within 250 ms.",
      });
      await silent.close();

      const closed = await startProvider(() => undefined);
      const baseUrl = closed.baseUrl;
      await closed.close();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "gone",
          protocol: "openai_compatible",
          baseUrl,
          credentialMode: "none",
        },
        { context: org.context },
      );
      const unreachable = await call(
        modelProvidersRouter.providers.probe,
        { name: "gone" },
        { context: org.context },
      );
      expect(unreachable).toEqual({
        ok: false,
        reason: "Nothing is listening at the provider's base URL.",
      });
    });

    it("keeps a stored secret out of every failure it reports", async () => {
      const org = await createOrg();
      const refusing = await startProvider((_request, response) => {
        response.writeHead(500);
        response.end("no");
      });
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: refusing.baseUrl,
          credential: "placeholder-secret",
        },
        { context: org.context },
      );

      // A credential the transport refuses as a header: undici reports it by
      // quoting the offending value, which is the whole reason the probe never
      // repeats an error message it did not write.
      const smuggled = "sk-live\nx-injected: 1";
      await db.modelProvider.update({
        where: { orgId_name: { orgId: org.org.id, name: "primary" } },
        data: { credentialCiphertext: encryptEnvelope(smuggled, masterKey) },
      });
      const rejected = await call(
        modelProvidersRouter.providers.probe,
        { name: "primary" },
        { context: org.context },
      );
      expect(rejected).toEqual({
        ok: false,
        reason:
          "The provider could not be reached. Check the base URL, the stored headers, and the credential.",
      });
      expect(JSON.stringify(rejected)).not.toContain("sk-live");
      await refusing.close();

      // The same guarantee on the branch that reports a plain HTTP failure, and
      // on the one where nothing is listening at all.
      await db.modelProvider.update({
        where: { orgId_name: { orgId: org.org.id, name: "primary" } },
        data: { credentialCiphertext: encryptEnvelope("sk-live-plain", masterKey) },
      });
      const failed = await call(
        modelProvidersRouter.providers.probe,
        { name: "primary" },
        { context: org.context },
      );
      expect(JSON.stringify(failed)).not.toContain("sk-live-plain");
      expect(failed).toEqual({
        ok: false,
        reason: "Nothing is listening at the provider's base URL.",
      });
    });

    it("refuses a credential or header value that cannot become a header", async () => {
      const org = await createOrg();

      await expect(
        call(
          modelProvidersRouter.providers.put,
          { ...openAiCompatible, name: "primary", credential: "sk-live\nx-injected: 1" },
          { context: org.context },
        ),
      ).rejects.toThrow(/control characters/);
      await expect(
        putProvider(db, {
          orgId: org.org.id,
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: "https://models.example.test/v1",
          credential: "sk-live\nx-injected: 1",
          masterKey,
        }),
      ).rejects.toThrow(/control characters/);
      await expect(
        call(
          modelProvidersRouter.providers.put,
          {
            ...openAiCompatible,
            name: "primary",
            credential: "fine",
            headers: { "x-tenant": "acme\r\nx-injected: 1" },
          },
          { context: org.context },
        ),
      ).rejects.toThrow(/control characters/);
      await expect(
        call(
          modelProvidersRouter.providers.put,
          {
            ...openAiCompatible,
            name: "primary",
            credential: "fine",
            headers: { "x tenant": "acme" },
          },
          { context: org.context },
        ),
      ).rejects.toThrow(/not a valid HTTP header/);
    });

    it("does not follow a redirect away from the base URL", async () => {
      const elsewhere = await startProvider((request, response) => {
        // Nothing should arrive here: the probe stops at the redirect.
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [], seen: request.headers["x-tenant"] }));
      });
      const redirecting = await startProvider((_request, response) => {
        response.writeHead(302, { location: `${elsewhere.baseUrl}/models` });
        response.end();
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "moved",
          protocol: "openai_compatible",
          baseUrl: redirecting.baseUrl,
          credential: "the-secret",
          headers: { "x-tenant": "acme" },
        },
        { context: org.context },
      );

      expect(
        await call(
          modelProvidersRouter.providers.probe,
          { name: "moved" },
          { context: org.context },
        ),
      ).toMatchObject({ ok: false, reason: expect.stringContaining("redirect") });

      await redirecting.close();
      await elsewhere.close();
    });

    it("reads the models a provider offers, for the catalog to import", async () => {
      const seen: { path?: string | undefined; authorization?: string | undefined } = {};
      const provider = await startProvider((request, response) => {
        seen.path = request.url;
        seen.authorization = request.headers.authorization;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            // Out of order, with one repeat and one entry that has no id: what
            // a gateway actually returns.
            data: [
              { id: "small-model" },
              { id: "big-model" },
              { id: "small-model" },
              { object: "model" },
            ],
          }),
        );
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "primary" },
        { context: org.context },
      );
      expect(result).toMatchObject({
        ok: true,
        models: [{ id: "big-model" }, { id: "small-model" }],
      });
      expect(seen.path).toBe("/v1/models");
      expect(seen.authorization).toBe("Bearer the-secret");
      expect(JSON.stringify(result)).not.toContain("the-secret");

      await provider.close();
    });

    it("carries through the capability a listing states about its own models", async () => {
      const provider = await startProvider((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              // The two shapes a listing states this in: a top-level type, and
              // the output modalities of an architecture block.
              { id: "typed-embedder", type: "embedding" },
              { id: "typed-chat", type: "chat" },
              { id: "modal-embedder", architecture: { output_modalities: ["embeddings"] } },
              { id: "modal-chat", architecture: { output_modalities: ["text"] } },
            ],
          }),
        );
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "stating",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "stating" },
        { context: org.context },
      );
      expect(result).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        models: [
          { id: "modal-chat", embedding: false },
          { id: "modal-embedder", embedding: true },
          { id: "typed-chat", embedding: false },
          { id: "typed-embedder", embedding: true },
        ],
      });
      expect(JSON.stringify(result)).not.toContain("the-secret");

      await provider.close();
    });

    it("states nothing about a model whose listing carries no capability it recognizes", async () => {
      const provider = await startProvider((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            data: [
              // The plain OpenAI-compatible entry, which says nothing.
              { id: "plain", object: "model" },
              // A gateway's own vocabulary is not the one being read, and a
              // guess dressed as a statement is worse than silence.
              { id: "own-words", type: "model" },
              // Shapes that are the right field and the wrong thing.
              { id: "wrong-type", type: 7 },
              { id: "wrong-architecture", architecture: null },
              { id: "wrong-modalities", architecture: { output_modalities: "embeddings" } },
              { id: "mixed-modalities", architecture: { output_modalities: ["text", 3] } },
            ],
          }),
        );
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "silent",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "silent" },
        { context: org.context },
      );
      expect(result).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        models: [
          { id: "mixed-modalities" },
          { id: "own-words" },
          { id: "plain" },
          { id: "wrong-architecture" },
          { id: "wrong-modalities" },
          { id: "wrong-type" },
        ],
      });

      await provider.close();
    });

    it("reads the model list with the query the provider stores", async () => {
      const seen: { path?: string | undefined } = {};
      const provider = await startProvider((request, response) => {
        seen.path = request.url;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "listed" }] }));
      });
      const org = await createOrg();
      const created = await call(
        modelProvidersRouter.providers.put,
        {
          name: "filtered",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
          listQuery: { output_modalities: "all" },
        },
        { context: org.context },
      );
      expect(created.listQuery).toEqual({ output_modalities: "all" });

      await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "filtered" },
        { context: org.context },
      );
      expect(seen.path).toBe("/v1/models?output_modalities=all");

      // The probe is the same call, so it asks the same question.
      await call(
        modelProvidersRouter.providers.probe,
        { name: "filtered" },
        { context: org.context },
      );
      expect(seen.path).toBe("/v1/models?output_modalities=all");

      // Clearing it puts the plain listing back.
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "filtered",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          listQuery: null,
        },
        { context: org.context },
      );
      await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "filtered" },
        { context: org.context },
      );
      expect(seen.path).toBe("/v1/models");

      await provider.close();
    });

    it("reports a model list it could not fetch without repeating the credential", async () => {
      const rejecting = await startProvider((_request, response) => {
        response.writeHead(401);
        response.end("nope");
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "rejecting",
          protocol: "openai_compatible",
          baseUrl: rejecting.baseUrl,
          credential: "stale-secret",
        },
        { context: org.context },
      );

      const rejected = await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "rejecting" },
        { context: org.context },
      );
      expect(rejected).toEqual({
        ok: false,
        reason: "The provider rejected the credential (HTTP 401).",
      });
      expect(JSON.stringify(rejected)).not.toContain("stale-secret");
      await rejecting.close();

      // Nothing listening: the catalog editor keeps working by hand, so this
      // stays a result rather than an error.
      const unreachable = await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "rejecting" },
        { context: org.context },
      );
      expect(unreachable).toEqual({
        ok: false,
        reason: "Nothing is listening at the provider's base URL.",
      });
      expect(JSON.stringify(unreachable)).not.toContain("stale-secret");
    });

    it("refuses to reach a provider that is not in the registry", async () => {
      const org = await createOrg();
      await expect(
        call(modelProvidersRouter.providers.probe, { name: "absent" }, { context: org.context }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(
        call(
          modelProvidersRouter.providers.remoteModels,
          { name: "absent" },
          { context: org.context },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
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
