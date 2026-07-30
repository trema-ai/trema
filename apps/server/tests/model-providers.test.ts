import { generateKeyPairSync, randomUUID } from "node:crypto";
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
  putDefaults,
  putProvider,
  resolveEndpoints,
  resolveRoleModel,
  seedModelProvidersFromEnv,
} from "#server/services/model-providers/index.js";
import { fetchRemoteModels, probeProvider } from "#server/services/model-providers/remote.js";
import { ModelConfigurationError, resolveConfiguredModel } from "#server/services/runs/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 5).toString("base64");

/**
 * A throwaway key pair, generated here rather than checked in: the Vertex
 * listing test needs a grant the auth library will actually sign, and a private
 * key in the repository is a private key in the repository whatever it opens.
 */
const serviceAccountKey = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
}).privateKey;

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

  async function addMember(orgId: string) {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "Registry Member", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const user = await db.user.findUniqueOrThrow({ where: { email } });
    const scope = await db.scope.findFirstOrThrow({ where: { orgId, kind: "org" } });
    const principal = await db.principal.create({
      data: {
        orgId,
        kind: "human",
        authId: user.id,
        displayName: "Registry Member",
        email,
      },
    });
    await db.grant.create({
      data: { orgId, scopeId: scope.id, principalId: principal.id, role: "member" },
    });
    await db.session.updateMany({
      where: { userId: user.id },
      data: { activeOrgId: orgId },
    });
    return { db, auth, env, headers: new Headers({ cookie }) };
  }

  const openAiCompatible = {
    protocol: "openai_compatible",
    baseUrl: "https://models.example.test/v1",
  } as const;

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

  /**
   * A loopback address with nothing listening. A create reads the provider's
   * model list, so a test that does not care about the list still needs an
   * endpoint that fails fast rather than a name that resolves off the machine.
   */
  async function closedEndpoint(): Promise<string> {
    const server = await startProvider(() => undefined);
    await server.close();
    return server.baseUrl;
  }

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

  it("lists only offered catalog data through the member-safe read", async () => {
    const org = await createOrg();
    const memberContext = await addMember(org.org.id);
    await db.modelProvider.create({
      data: {
        orgId: org.org.id,
        name: "picker",
        label: "Picker Provider",
        protocol: "openai_compatible",
        baseUrl: "https://models.example.test/v1",
        credentialMode: "none",
        headersJson: { "x-internal": "private-header" },
        catalogJson: [
          { id: "shown", label: "Shown Model", offered: true, contextWindow: 128_000 },
          { id: "hidden", label: "Hidden Model" },
        ],
      },
    });

    await expect(
      call(modelProvidersRouter.providers.list, {}, { context: memberContext }),
    ).rejects.toMatchObject({ code: "FORBIDDEN" });
    const listed = await call(
      modelProvidersRouter.models.offered,
      {},
      {
        context: memberContext,
      },
    );

    expect(listed).toEqual([
      {
        providerName: "picker",
        providerLabel: "Picker Provider",
        modelId: "shown",
        label: "Shown Model",
        contextWindow: 128_000,
      },
    ]);
    expect(JSON.stringify(listed)).not.toContain("private-header");
    expect(JSON.stringify(listed)).not.toContain("models.example.test");
    expect(JSON.stringify(listed)).not.toContain("hidden");
  });

  it("falls back to the turns chain when a stored model is stale", async () => {
    const org = await createOrg();
    await putProvider(db, {
      orgId: org.org.id,
      name: "primary",
      protocol: "openai_compatible",
      baseUrl: "https://models.example.test/v1",
      credentialMode: "none",
      catalog: [{ id: "default-model", offered: true }],
    });
    await putDefaults(db, {
      orgId: org.org.id,
      role: "turns",
      chain: [{ providerName: "primary", modelId: "default-model" }],
    });

    const resolved = await resolveConfiguredModel(db, org.org.id, {
      model: { providerName: "primary", modelId: "removed-model" },
    });

    expect(resolved.model).toEqual({ provider: "primary", id: "default-model" });
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
    const baseUrl = await closedEndpoint();

    const created = await call(
      modelProvidersRouter.providers.create,
      { ...openAiCompatible, baseUrl, name: "primary", label: "First", credential: "first-secret" },
      { context: org.context },
    );
    expect(created).toMatchObject({ name: "primary", label: "First" });

    // The unique index answers, not a read: two admins creating the same
    // provider at once cannot both believe they won.
    await expect(
      call(
        modelProvidersRouter.providers.create,
        {
          ...openAiCompatible,
          baseUrl,
          name: "primary",
          label: "Second",
          credential: "second-secret",
        },
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

  it("stores the settings a protocol declares and refuses the ones it does not", async () => {
    const org = await createOrg();
    const bedrock = {
      name: "bedrock",
      protocol: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      credentialMode: "aws_sigv4",
    } as const;

    // The one protocol that takes settings needs them: a signature names a
    // region whatever host answers, and no address is asked to carry one.
    await expect(
      call(modelProvidersRouter.providers.put, bedrock, { context: org.context }),
    ).rejects.toThrow(/needs a region/);
    // A blank one is refused at the edge, before the service reads it.
    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...bedrock, settings: { region: "   " } },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    // Every other protocol refuses a value outright rather than storing one
    // nothing will read.
    await expect(
      call(
        modelProvidersRouter.providers.put,
        {
          ...openAiCompatible,
          name: "primary",
          credential: "the-secret",
          settings: { region: "us-east-1" },
        },
        { context: org.context },
      ),
    ).rejects.toThrow(/takes no settings/);

    const stored = await call(
      modelProvidersRouter.providers.put,
      {
        ...bedrock,
        settings: { region: "us-east-1" },
        credential: JSON.stringify({
          accessKeyId: "AKIAEXAMPLEKEYID",
          secretAccessKey: "the-signing-secret",
          sessionToken: "the-session-token",
        }),
      },
      { context: org.context },
    );
    // Read back in full, unlike the credential beside it: it is configuration,
    // not a secret.
    expect(stored).toMatchObject({
      settings: { region: "us-east-1" },
      credentialMode: "aws_sigv4",
      hasCredential: true,
    });
    expect(JSON.stringify(stored)).not.toContain("the-signing-secret");

    // An edit that touches nothing else keeps what is stored.
    const renamed = await call(
      modelProvidersRouter.providers.put,
      { ...bedrock, label: "Bedrock" },
      { context: org.context },
    );
    expect(renamed).toMatchObject({ label: "Bedrock", settings: { region: "us-east-1" } });

    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.bedrock).toEqual({
      protocol: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
      accessKeyId: "AKIAEXAMPLEKEYID",
      secretAccessKey: "the-signing-secret",
      sessionToken: "the-session-token",
    });
  });

  it("takes a signing credential as a key pair, or none at all", async () => {
    const org = await createOrg();
    const bedrock = {
      name: "bedrock",
      protocol: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      credentialMode: "aws_sigv4",
      settings: { region: "us-east-1" },
    } as const;

    for (const credential of [
      "not-json",
      JSON.stringify({ accessKeyId: "AKIAEXAMPLEKEYID" }),
      JSON.stringify({ accessKeyId: "AKIAEXAMPLEKEYID", secretAccessKey: "" }),
      JSON.stringify({ accessKeyId: "AKIAEXAMPLEKEYID", secretAccessKey: "s", extra: "no" }),
    ]) {
      await expect(
        call(
          modelProvidersRouter.providers.put,
          { ...bedrock, credential },
          { context: org.context },
        ),
      ).rejects.toThrow(/AWS credential/);
    }

    // No credential at all is the ambient role the spec names: a supported
    // configuration, so the descriptor carries a region and no keys.
    const ambient = await call(modelProvidersRouter.providers.put, bedrock, {
      context: org.context,
    });
    expect(ambient).toMatchObject({ credentialMode: "aws_sigv4", hasCredential: false });
    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.bedrock).toEqual({
      protocol: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
    });

    // A stored credential belongs to the mode that wrote it, so a row moving
    // to or from signing has to restate it rather than inherit a shape the new
    // mode cannot read.
    await call(
      modelProvidersRouter.providers.put,
      { ...bedrock, credential: JSON.stringify({ accessKeyId: "A", secretAccessKey: "B" }) },
      { context: org.context },
    );
    await expect(
      call(
        modelProvidersRouter.providers.put,
        {
          name: "bedrock",
          protocol: "openai_compatible",
          baseUrl: "https://models.example.test/v1",
          credentialMode: "api_key",
        },
        { context: org.context },
      ),
    ).rejects.toThrow(/entering its credential again/);
  });

  it("takes only the credential modes a protocol can spend", async () => {
    const org = await createOrg();

    // A protocol and a mode are one decision. The pair refused here is the one
    // that reads as configured on the screen and vanishes at resolution: a
    // Bedrock row holding a plain string nothing can sign with.
    await expect(
      call(
        modelProvidersRouter.providers.put,
        {
          name: "mismatched",
          protocol: "bedrock",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          credentialMode: "api_key",
          credential: "not-a-key-pair",
          settings: { region: "us-east-1" },
        },
        { context: org.context },
      ),
    ).rejects.toThrow("The bedrock protocol authenticates with aws_sigv4, not api_key");
    // And the other way round: a signing mode on a protocol that has nothing to
    // sign with is refused by the same lookup.
    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...openAiCompatible, name: "signed-openai", credentialMode: "gcp_adc" },
        { context: org.context },
      ),
    ).rejects.toThrow(
      "The openai_compatible protocol authenticates with api_key or none, not gcp_adc",
    );

    // A create that names no mode lands in the one its protocol leads with, so
    // adding a Bedrock row is not a matter of knowing the word `aws_sigv4`.
    const created = await call(
      modelProvidersRouter.providers.put,
      {
        name: "bedrock",
        protocol: "bedrock",
        baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
        settings: { region: "us-east-1" },
      },
      { context: org.context },
    );
    expect(created).toMatchObject({ credentialMode: "aws_sigv4", hasCredential: false });
    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.bedrock).toEqual({
      protocol: "bedrock",
      baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
      region: "us-east-1",
    });
  });

  it("takes a Vertex service account as the key file it was downloaded as, or none at all", async () => {
    const org = await createOrg();
    const vertex = {
      name: "vertex",
      protocol: "vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
      credentialMode: "gcp_adc",
    } as const;

    // This protocol takes two settings and needs both: a model lives under a
    // project and a location, and the address carries neither.
    await expect(
      call(modelProvidersRouter.providers.put, vertex, { context: org.context }),
    ).rejects.toThrow(/needs a project and a location/);
    await expect(
      call(
        modelProvidersRouter.providers.put,
        { ...vertex, settings: { project: "trema-test" } },
        { context: org.context },
      ),
    ).rejects.toThrow(/needs a project and a location/);

    const settings = { project: "trema-test", location: "us-central1" } as const;
    for (const credential of [
      "not-json",
      JSON.stringify({ client_email: "svc@trema-test.iam.gserviceaccount.example" }),
      JSON.stringify({
        client_email: "svc@trema-test.iam.gserviceaccount.example",
        private_key: "",
      }),
    ]) {
      await expect(
        call(
          modelProvidersRouter.providers.put,
          { ...vertex, settings, credential },
          { context: org.context },
        ),
      ).rejects.toThrow(/Google credential/);
    }

    // The whole key file goes in, formatting and spare fields and all, because
    // that is what the console hands an admin.
    const stored = await call(
      modelProvidersRouter.providers.put,
      {
        ...vertex,
        settings,
        credential: JSON.stringify(
          {
            type: "service_account",
            project_id: "trema-test",
            private_key_id: "fedcba9876543210",
            private_key:
              "-----BEGIN PRIVATE KEY-----\nthe-signing-secret\n-----END PRIVATE KEY-----\n",
            client_email: "svc@trema-test.iam.gserviceaccount.example",
            client_id: "1234567890",
            token_uri: "https://oauth2.googleapis.com/token",
          },
          null,
          2,
        ),
      },
      { context: org.context },
    );
    expect(stored).toMatchObject({
      settings,
      credentialMode: "gcp_adc",
      hasCredential: true,
    });
    expect(JSON.stringify(stored)).not.toContain("the-signing-secret");

    // The descriptor carries the two fields a token exchange spends, and the
    // rest of the file is gone rather than stored unread.
    const endpoints = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(endpoints.vertex).toEqual({
      protocol: "vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
      project: "trema-test",
      location: "us-central1",
      serviceAccount: {
        clientEmail: "svc@trema-test.iam.gserviceaccount.example",
        privateKey: "-----BEGIN PRIVATE KEY-----\nthe-signing-secret\n-----END PRIVATE KEY-----",
      },
    });

    // A row moving between two structured shapes has to restate its credential,
    // which is the rule the signing mode brought, applied to a second pairing.
    await expect(
      call(
        modelProvidersRouter.providers.put,
        {
          name: "vertex",
          protocol: "bedrock",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          credentialMode: "aws_sigv4",
          settings: { region: "us-east-1" },
        },
        { context: org.context },
      ),
    ).rejects.toThrow(/entering its credential again/);

    // No credential at all is the application-default configuration the spec
    // names: a supported state, so the descriptor carries the address and no
    // key material.
    await call(
      modelProvidersRouter.providers.put,
      { ...vertex, settings, credential: null },
      { context: org.context },
    );
    const ambient = await resolveEndpoints(db, org.org.id, { masterKey });
    expect(ambient.vertex).toEqual({
      protocol: "vertex",
      baseUrl: "https://us-central1-aiplatform.googleapis.com/v1beta1",
      project: "trema-test",
      location: "us-central1",
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
      call(modelProvidersRouter.providers.refreshCatalog, { name: "primary" }, { context }),
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
    // A vendor is a preset over a protocol, and more than one protocol is
    // implemented, so the bundled set spans them.
    expect(new Set(presets.map((preset) => preset.protocol)).size).toBeGreaterThan(1);
    for (const preset of presets) {
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
    // The endpoint is a closed loopback port rather than the vendor's own: a
    // create reads the provider's model list, and no test reaches a vendor.
    const preset = presets[0];
    if (!preset) throw new Error("A preset is required");
    const created = await call(
      modelProvidersRouter.providers.create,
      {
        name: preset.name,
        label: preset.label,
        protocol: preset.protocol,
        baseUrl: await closedEndpoint(),
        credentialMode: preset.credentialMode,
        credential: preset.credentialMode === "api_key" ? "preset-secret" : null,
      },
      { context: org.context },
    );
    expect(created).toMatchObject({ name: preset.name, label: preset.label });
    // The listing never answered, and the provider is stored all the same.
    expect(created.catalog).toEqual([]);
  });

  describe("health probe", () => {
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

    it("carries the credential in the header the stored protocol names", async () => {
      const seen: {
        authorization?: string | undefined;
        apiKey?: string | undefined;
        version?: string | undefined;
      } = {};
      const provider = await startProvider((request, response) => {
        seen.authorization = request.headers.authorization;
        seen.apiKey = request.headers["x-api-key"] as string;
        seen.version = request.headers["anthropic-version"] as string;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "listed-model" }], has_more: false }));
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "keyed",
          protocol: "anthropic",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.probe,
        { name: "keyed" },
        { context: org.context },
      );
      expect(result).toMatchObject({ ok: true, modelCount: 1 });
      // The credential is spent on the header this protocol names, and the
      // dated version it requires rides beside it. A bearer token, which is
      // what the other protocol sends, would have been refused here.
      expect(seen.apiKey).toBe("the-secret");
      expect(seen.version).toBe("2023-06-01");
      expect(seen.authorization).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("the-secret");

      await provider.close();
    });

    it("carries the credential in the key header the google protocol names", async () => {
      const seen: { authorization?: string | undefined; apiKey?: string | undefined } = {};
      const provider = await startProvider((request, response) => {
        seen.authorization = request.headers.authorization;
        seen.apiKey = request.headers["x-goog-api-key"] as string;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ models: [{ name: "models/listed-model" }] }));
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "gemini",
          protocol: "google",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.probe,
        { name: "gemini" },
        { context: org.context },
      );
      // The count comes from the array this protocol puts its models in, which
      // is a third thing again from the header — the probe reads both.
      expect(result).toMatchObject({ ok: true, modelCount: 1 });
      expect(seen.apiKey).toBe("the-secret");
      expect(seen.authorization).toBeUndefined();
      expect(JSON.stringify(result)).not.toContain("the-secret");

      await provider.close();
    });

    it("carries the credential as a bearer token on the openai-responses protocol", async () => {
      const seen: { authorization?: string | undefined; path?: string | undefined } = {};
      const provider = await startProvider((request, response) => {
        seen.authorization = request.headers.authorization;
        seen.path = request.url;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: [{ id: "gpt-5-deployment" }], has_more: false }));
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "azure-openai",
          protocol: "openai_responses",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.probe,
        { name: "azure-openai" },
        { context: org.context },
      );
      // A different wire shape for turns does not mean a different listing:
      // this protocol keeps the OpenAI-shaped `/models` call and the bearer
      // token that goes with it.
      expect(result).toMatchObject({ ok: true, modelCount: 1 });
      expect(seen.path).toBe("/v1/models");
      expect(seen.authorization).toBe("Bearer the-secret");
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

    it("reads a listing that names its array and its models differently", async () => {
      const provider = await startProvider((_request, response) => {
        response.writeHead(200, { "content-type": "application/json" });
        response.end(
          JSON.stringify({
            // The array is `models`, not `data`, and an entry names itself by
            // its resource path rather than by an id.
            models: [
              {
                name: "models/gemini-2.0-flash",
                supportedGenerationMethods: ["generateContent", "streamGenerateContent"],
              },
              { name: "models/text-embedding-004", supportedGenerationMethods: ["embedContent"] },
              // A stated list that does not name the embedding call states a
              // no; an absent or malformed one states nothing at all.
              { name: "models/imagen-3.0", supportedGenerationMethods: [] },
              { name: "models/quiet" },
              { name: "models/wrong-methods", supportedGenerationMethods: "embedContent" },
              // An id wins where a listing carries both, and an entry that
              // names itself nothing usable is skipped.
              { name: "models/ignored", id: "stated-id" },
              { name: "models/" },
            ],
          }),
        );
      });
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "gemini",
          protocol: "google",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );

      const result = await call(
        modelProvidersRouter.providers.remoteModels,
        { name: "gemini" },
        { context: org.context },
      );
      // The collection prefix comes off: what is stored is what the wire
      // protocol takes back as a model id.
      expect(result).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        models: [
          { id: "gemini-2.0-flash", embedding: false },
          { id: "imagen-3.0", embedding: false },
          { id: "quiet" },
          { id: "stated-id" },
          { id: "text-embedding-004", embedding: true },
          { id: "wrong-methods" },
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

    /**
     * Bedrock's listing is answered by a host no test may reach, so these use
     * an injected fetch rather than a loopback server: the address under test
     * is precisely the one this module derives, and a stand-in server would
     * have to be asked at an address it made up.
     */
    function fakeFetch(body: unknown) {
      const seen: { url?: string | undefined; headers?: Headers | undefined } = {};
      const fetch: typeof globalThis.fetch = async (url, init) => {
        seen.url = String(url);
        seen.headers = new Headers(init?.headers);
        return new Response(JSON.stringify(body), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      };
      return { seen, fetch };
    }

    const bedrockKeys = JSON.stringify({
      accessKeyId: "AKIAEXAMPLEKEYID",
      secretAccessKey: "the-signing-secret",
    });

    it("signs the model listing for the control plane rather than the runtime host", async () => {
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "bedrock",
          protocol: "bedrock",
          baseUrl: "https://bedrock-runtime.eu-west-1.amazonaws.com",
          credentialMode: "aws_sigv4",
          credential: bedrockKeys,
          settings: { region: "eu-west-1" },
          // Stored as an admin typed it, capitals and all: the signer names
          // headers as it normalizes them, so a set added beside the signed one
          // would arrive as a second, differently-cased copy.
          headers: { "X-Tenant": "acme" },
        },
        { context: org.context },
      );

      const call1 = fakeFetch({
        modelSummaries: [
          { modelId: "anthropic.claude-sonnet-4-5-20250929-v1:0", outputModalities: ["TEXT"] },
          { modelId: "amazon.titan-embed-text-v2:0", outputModalities: ["EMBEDDING"] },
          { modelId: "amazon.nova-canvas-v1:0", outputModalities: ["IMAGE"] },
          // A stated list is read either way; an entry that states none says
          // nothing at all, which is not the same as saying no.
          { modelId: "amazon.titan-quiet" },
        ],
      });
      const listed = await fetchRemoteModels(db, org.org.id, "bedrock", {
        masterKey,
        fetch: call1.fetch,
      });

      // The runtime host serves model calls; the catalog lives on the control
      // plane, so the listing swaps the leading label rather than reusing the
      // stored address.
      expect(call1.seen.url).toBe("https://bedrock.eu-west-1.amazonaws.com/foundation-models");
      const authorization = call1.seen.headers?.get("authorization") ?? "";
      expect(authorization).toContain("AWS4-HMAC-SHA256");
      expect(authorization).toContain("Credential=AKIAEXAMPLEKEYID/");
      expect(authorization).toMatch(/\/eu-west-1\/bedrock\/aws4_request/);
      expect(call1.seen.headers?.get("x-amz-date")).toMatch(/^\d{8}T\d{6}Z$/);
      // The builder returns the whole header set, so the stored header travels
      // once — a second copy would show up here joined with a comma — and it is
      // inside the signature rather than beside it.
      expect(call1.seen.headers?.get("x-tenant")).toBe("acme");
      const signedHeaders = authorization.match(/signedheaders=([^,]+)/i)?.[1] ?? "";
      expect(signedHeaders.split(";")).toContain("x-tenant");
      // The secret signs the request and never travels in it.
      expect(JSON.stringify([...(call1.seen.headers ?? [])])).not.toContain("the-signing-secret");
      expect(listed).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        models: [
          { id: "amazon.nova-canvas-v1:0", embedding: false },
          { id: "amazon.titan-embed-text-v2:0", embedding: true },
          { id: "amazon.titan-quiet" },
          { id: "anthropic.claude-sonnet-4-5-20250929-v1:0", embedding: false },
        ],
      });

      // A private endpoint says nothing about who serves the catalog, so the
      // region's own control-plane host is what the listing asks. It is a
      // guess that fails legibly rather than one that asks a gateway for a
      // path it does not serve.
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "bedrock",
          protocol: "bedrock",
          baseUrl: "https://vpce-01234.bedrock-runtime.example.test",
          credentialMode: "aws_sigv4",
          settings: { region: "eu-west-1" },
        },
        { context: org.context },
      );
      const call2 = fakeFetch({ modelSummaries: [] });
      await fetchRemoteModels(db, org.org.id, "bedrock", { masterKey, fetch: call2.fetch });
      expect(call2.seen.url).toBe("https://bedrock.eu-west-1.amazonaws.com/foundation-models");
    });

    it("says the model list needs keys of its own when the row signs with an ambient role", async () => {
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "ambient",
          protocol: "bedrock",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          credentialMode: "aws_sigv4",
          settings: { region: "us-east-1" },
        },
        { context: org.context },
      );
      expect(
        await call(
          modelProvidersRouter.providers.get,
          { name: "ambient" },
          { context: org.context },
        ),
      ).toMatchObject({ credentialMode: "aws_sigv4", hasCredential: false });

      let called = false;
      const fetch: typeof globalThis.fetch = async () => {
        called = true;
        return new Response("{}", { status: 200 });
      };
      // The run path may sign with the worker's own role, through the SDK. A
      // listing speaks for one registry row, so it spends that row's keys or
      // reports that it has none, and it never reaches for the server's.
      const result = await fetchRemoteModels(db, org.org.id, "ambient", { masterKey, fetch });
      expect(result).toEqual({
        ok: false,
        reason:
          "Reading this provider's models needs stored AWS keys. Enter them, then refresh the model list.",
      });
      expect(await probeProvider(db, org.org.id, "ambient", { masterKey, fetch })).toMatchObject({
        ok: false,
      });
      expect(called).toBe(false);
    });

    it("reports a stored configuration it cannot read as a failed probe", async () => {
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "hand-edited",
          protocol: "bedrock",
          baseUrl: "https://bedrock-runtime.us-east-1.amazonaws.com",
          credentialMode: "aws_sigv4",
          settings: { region: "us-east-1" },
        },
        { context: org.context },
      );
      // Written past the service, the way a restored backup or a column edited
      // by hand arrives: a shape the protocol never declared.
      await db.modelProvider.update({
        where: { orgId_name: { orgId: org.org.id, name: "hand-edited" } },
        data: { settingsJson: { region: 5 } },
      });

      let called = false;
      const fetch: typeof globalThis.fetch = async () => {
        called = true;
        return new Response("{}", { status: 200 });
      };
      // "Is this provider usable" is the question both screens ask, so an
      // unreadable row answers it with a sentence rather than a transport
      // error the screen has nowhere to put.
      expect(await probeProvider(db, org.org.id, "hand-edited", { masterKey, fetch })).toEqual({
        ok: false,
        reason: "The stored configuration cannot be read. Save the provider again to replace it.",
      });
      expect(called).toBe(false);
    });

    /**
     * Vertex's listing is answered by a host no test may reach, and its token
     * exchange by another, so these use an injected fetch for both. The
     * exchange rides the same one on purpose: the builder is handed the fetch
     * the listing will use, which is what makes a hermetic test of it possible
     * at all.
     */
    it("mints a token from the stored service account and reads the publisher listing", async () => {
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "vertex",
          protocol: "vertex",
          baseUrl: "https://us-central1-aiplatform.example.test/v1beta1",
          credentialMode: "gcp_adc",
          settings: { project: "trema-test", location: "us-central1" },
          credential: JSON.stringify({
            type: "service_account",
            client_email: "svc@trema-test.iam.gserviceaccount.example",
            private_key: serviceAccountKey,
          }),
          listQuery: { pageSize: "1000" },
        },
        { context: org.context },
      );

      const seen: { url: string; authorization: string | null }[] = [];
      const fetch: typeof globalThis.fetch = async (url, init) => {
        seen.push({
          url: String(url),
          authorization: new Headers(init?.headers).get("authorization"),
        });
        if (String(url) === "https://oauth2.googleapis.com/token") {
          return new Response(
            JSON.stringify({
              access_token: "ya29.minted-token",
              token_type: "Bearer",
              expires_in: 3600,
            }),
            { status: 200, headers: { "content-type": "application/json" } },
          );
        }
        return new Response(
          JSON.stringify({
            // The array is `publisherModels`, and an entry names itself by a
            // resource path qualified with its publisher.
            publisherModels: [
              { name: "publishers/google/models/gemini-2.5-flash", versionId: "001" },
              { name: "publishers/google/models/text-embedding-005" },
              { name: "publishers/google/models/" },
            ],
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      };
      const listed = await fetchRemoteModels(db, org.org.id, "vertex", { masterKey, fetch });

      expect(seen[0]?.url).toBe("https://oauth2.googleapis.com/token");
      // The listing hangs off the stored base URL, carries the preset's page
      // size, and names no project: the catalog is the publisher's, and the
      // token says whose quota reads it.
      expect(seen[1]?.url).toBe(
        "https://us-central1-aiplatform.example.test/v1beta1/publishers/google/models?pageSize=1000",
      );
      expect(seen[1]?.authorization).toBe("Bearer ya29.minted-token");
      // The publisher prefix comes off with the collection prefix: what is
      // stored has to be what a request can put on the wire. Nothing carries an
      // embedding hint, because this listing states none — its entries describe
      // console actions, not modalities.
      expect(listed).toEqual({
        ok: true,
        latencyMs: expect.any(Number),
        models: [{ id: "gemini-2.5-flash" }, { id: "text-embedding-005" }],
      });
    });

    it("holds the token exchange to the listing's deadline", async () => {
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "stuck-vertex",
          protocol: "vertex",
          baseUrl: "https://us-central1-aiplatform.example.test/v1beta1",
          credentialMode: "gcp_adc",
          settings: { project: "trema-test", location: "us-central1" },
          credential: JSON.stringify({
            type: "service_account",
            client_email: "svc@trema-test.iam.gserviceaccount.example",
            private_key: serviceAccountKey,
          }),
        },
        { context: org.context },
      );

      // A token endpoint that never answers, until the deadline the builder
      // was handed aborts it. Without that shared deadline this promise never
      // settles and the probe hangs with it. An already-aborted signal rejects
      // straight away, the way a real fetch does — the auth library retries a
      // failed exchange, and the retry arrives after the deadline has passed.
      const fetch: typeof globalThis.fetch = (_url, init) =>
        new Promise((_resolve, reject) => {
          if (init?.signal?.aborted) return reject(init.signal.reason);
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
        });
      const result = await probeProvider(db, org.org.id, "stuck-vertex", {
        masterKey,
        fetch,
        timeoutMs: 50,
      });
      expect(result).toEqual({ ok: false, reason: "The provider did not answer within 50 ms." });
    });

    it("says the model list needs a service account of its own when the row has none", async () => {
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "ambient-vertex",
          protocol: "vertex",
          baseUrl: "https://us-central1-aiplatform.example.test/v1beta1",
          credentialMode: "gcp_adc",
          settings: { project: "trema-test", location: "us-central1" },
        },
        { context: org.context },
      );

      let called = false;
      const fetch: typeof globalThis.fetch = async () => {
        called = true;
        return new Response("{}", { status: 200 });
      };
      // The run path may let the provider fall back to the server's own
      // application-default credential. A listing speaks for one registry row,
      // so it spends that row's service account or reports that it has none.
      const result = await fetchRemoteModels(db, org.org.id, "ambient-vertex", {
        masterKey,
        fetch,
      });
      expect(result).toEqual({
        ok: false,
        reason:
          "Reading this provider's models needs a stored service account. Add one, then refresh the model list.",
      });
      expect(
        await probeProvider(db, org.org.id, "ambient-vertex", { masterKey, fetch }),
      ).toMatchObject({ ok: false });
      expect(called).toBe(false);
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
      await expect(
        call(
          modelProvidersRouter.providers.refreshCatalog,
          { name: "absent" },
          { context: org.context },
        ),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    });
  });

  describe("catalog refresh", () => {
    /** A stand-in whose model list the test changes between calls. */
    async function startListing(models: unknown[]) {
      const state = { models, path: undefined as string | undefined };
      const server = await startProvider((request, response) => {
        state.path = request.url;
        response.writeHead(200, { "content-type": "application/json" });
        response.end(JSON.stringify({ data: state.models }));
      });
      return { ...server, state };
    }

    it("reads a new provider's models as it is created", async () => {
      const provider = await startListing([
        { id: "small-model" },
        { id: "text-embedding-3-small" },
      ]);
      const org = await createOrg();

      const created = await call(
        modelProvidersRouter.providers.create,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );
      // The provider's listing is the menu, so the catalog arrives populated
      // and a role can name a model without anything being ticked first.
      expect(created.catalog).toEqual([{ id: "small-model" }, { id: "text-embedding-3-small" }]);
      expect(JSON.stringify(created)).not.toContain("the-secret");

      await provider.close();
    });

    it("stores a provider whose model list it could not read", async () => {
      const org = await createOrg();

      const created = await call(
        modelProvidersRouter.providers.create,
        {
          name: "unreachable",
          protocol: "openai_compatible",
          baseUrl: await closedEndpoint(),
          credential: "the-secret",
        },
        { context: org.context },
      );
      // A bad credential or an unreachable host is not a failed create: the row
      // is valid, and the admin refreshes it once the endpoint answers.
      expect(created).toMatchObject({ name: "unreachable", hasCredential: true });
      expect(created.catalog).toEqual([]);

      const refreshed = await call(
        modelProvidersRouter.providers.refreshCatalog,
        { name: "unreachable" },
        { context: org.context },
      );
      expect(refreshed).toEqual({
        ok: false,
        reason: "Nothing is listening at the provider's base URL.",
      });
      expect(JSON.stringify(refreshed)).not.toContain("the-secret");
    });

    it("keeps every annotation an admin made when the list is read again", async () => {
      const provider = await startListing([{ id: "big-model" }, { id: "small-model" }]);
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.create,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          catalog: [
            { id: "big-model", label: "Big model", offered: true, contextWindow: 128_000 },
            { id: "small-model" },
          ],
        },
        { context: org.context },
      );

      const refreshed = await call(
        modelProvidersRouter.providers.refreshCatalog,
        { name: "primary" },
        { context: org.context },
      );
      if (!refreshed.ok) throw new Error(refreshed.reason);
      // Re-import is not an edit: a label, a context window, and the picker
      // choice all survive the provider listing the model again.
      expect(refreshed.provider.catalog).toEqual([
        { id: "big-model", label: "Big model", offered: true, contextWindow: 128_000 },
        { id: "small-model" },
      ]);
      expect(refreshed).toMatchObject({ added: 0, removed: 0 });

      await provider.close();
    });

    it("drops an imported model the provider stopped listing and keeps the ones that carry intent", async () => {
      const provider = await startListing([
        { id: "kept-model" },
        { id: "labelled-model" },
        { id: "assigned-model" },
        { id: "forgotten-model" },
      ]);
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.create,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );
      await call(
        modelProvidersRouter.providers.put,
        {
          name: "primary",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          catalog: [
            { id: "kept-model" },
            { id: "labelled-model", label: "The one we call by name" },
            { id: "assigned-model" },
            { id: "forgotten-model" },
          ],
        },
        { context: org.context },
      );
      await call(
        modelProvidersRouter.defaults.put,
        { role: "turns", chain: [{ providerName: "primary", modelId: "assigned-model" }] },
        { context: org.context },
      );

      provider.state.models = [{ id: "kept-model" }, { id: "arrived-model" }];
      const refreshed = await call(
        modelProvidersRouter.providers.refreshCatalog,
        { name: "primary" },
        { context: org.context },
      );
      if (!refreshed.ok) throw new Error(refreshed.reason);
      // What the listing no longer names survives only where something says it
      // should: a label the admin wrote, or a role default that depends on it.
      expect(refreshed.provider.catalog.map((entry) => entry.id)).toEqual([
        "arrived-model",
        "assigned-model",
        "kept-model",
        "labelled-model",
      ]);
      expect(refreshed).toMatchObject({ added: 1, removed: 1 });
      expect(await resolveRoleModel(db, org.org.id, "turns")).toEqual({
        providerName: "primary",
        modelId: "assigned-model",
      });

      await provider.close();
    });

    it("imports every listed model bare, whatever the listing says each one is", async () => {
      const provider = await startListing([
        { id: "stated-vectors", type: "embedding" },
        { id: "stated-chat", type: "chat" },
        { id: "embed-in-name-only", type: "chat" },
        { id: "nomic-embed-text" },
        { id: "bge-large" },
        { id: "plain-model" },
      ]);
      const org = await createOrg();

      const created = await call(
        modelProvidersRouter.providers.create,
        {
          name: "stating",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
        },
        { context: org.context },
      );
      // What a model is for is the admin's to say, not the listing's to guess:
      // the catalog is the provider's menu and carries no judgement about it.
      expect(created.catalog).toEqual([
        { id: "bge-large" },
        { id: "embed-in-name-only" },
        { id: "nomic-embed-text" },
        { id: "plain-model" },
        { id: "stated-chat" },
        { id: "stated-vectors" },
      ]);

      await provider.close();
    });

    it("reads the model list with the query the provider stores", async () => {
      const provider = await startListing([{ id: "listed" }]);
      const org = await createOrg();
      await call(
        modelProvidersRouter.providers.create,
        {
          name: "filtered",
          protocol: "openai_compatible",
          baseUrl: provider.baseUrl,
          credential: "the-secret",
          listQuery: { output_modalities: "all" },
        },
        { context: org.context },
      );
      // The create's own listing carries it, so a provider whose list filters
      // itself answers in full the first time it is asked.
      expect(provider.state.path).toBe("/v1/models?output_modalities=all");

      await provider.close();
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
