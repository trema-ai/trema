import { randomUUID } from "node:crypto";

import { call } from "@orpc/server";
import { afterAll, beforeEach, describe, expect, it } from "vitest";

import { createAuth } from "#server/lib/auth/index.js";
import { createPrismaClient } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";
import { capabilitiesRouter } from "#server/rpc/capabilities.js";
import { orgRouter } from "#server/rpc/org.js";
import { resolveCapabilityProviders } from "#server/services/capabilities/index.js";

const testDatabaseUrl = process.env.TEST_DATABASE_URL;
const integration = testDatabaseUrl ? describe : describe.skip;
const databaseUrl = testDatabaseUrl ?? "postgresql://localhost/trema_test";
const masterKey = Buffer.alloc(32, 11).toString("base64");

integration("capability registry", () => {
  const db = createPrismaClient(databaseUrl);
  const env = parseEnv({
    NODE_ENV: "test",
    DATABASE_URL: databaseUrl,
    TREMA_AUTH_SECRET: "capability-registry-integration-secret-32",
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

  async function createOrg() {
    const email = `${randomUUID()}@example.com`;
    const response = await auth.api.signUpEmail({
      body: { name: "Capabilities Owner", email, password: "integration-password" },
      asResponse: true,
    });
    const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
    if (!cookie) throw new Error("Sign-up did not return a session cookie");
    const context = { db, auth, env, headers: new Headers({ cookie }) };
    const membership = await call(orgRouter.create, { name: "Capabilities Org" }, { context });
    return { ...membership, context };
  }

  it("stores search credentials as write-only values and resolves the route in order", async () => {
    const org = await createOrg();

    const brave = await call(
      capabilitiesRouter.providers.put,
      {
        name: "brave",
        label: "Brave Search",
        driverKey: "brave_search",
        credential: "brave-secret",
      },
      { context: org.context },
    );
    const tavily = await call(
      capabilitiesRouter.providers.put,
      {
        name: "tavily",
        label: "Tavily",
        driverKey: "tavily_search",
        credential: "tavily-secret",
      },
      { context: org.context },
    );
    expect(brave).toMatchObject({ hasCredential: true, capabilities: ["web.search"] });
    expect(tavily).toMatchObject({
      hasCredential: true,
      capabilities: ["web.search", "web.fetch"],
    });
    expect(JSON.stringify([brave, tavily])).not.toContain("secret");

    await call(
      capabilitiesRouter.routes.put,
      { capabilityKey: "web.search", chain: ["brave", "tavily"] },
      { context: org.context },
    );

    const resolved = await resolveCapabilityProviders(db, {
      orgId: org.org.id,
      capabilityKey: "web.search",
      masterKey,
    });
    expect(resolved.map(({ name, credential }) => ({ name, credential }))).toEqual([
      { name: "brave", credential: "brave-secret" },
      { name: "tavily", credential: "tavily-secret" },
    ]);

    const listed = await call(capabilitiesRouter.providers.list, {}, { context: org.context });
    expect(JSON.stringify(listed)).not.toContain("brave-secret");
    expect(JSON.stringify(listed)).not.toContain("tavily-secret");
  });

  it("uses a provider's fetch capability and disables it with an empty chain", async () => {
    const org = await createOrg();
    await call(
      capabilitiesRouter.providers.put,
      {
        name: "tavily",
        label: "Tavily",
        driverKey: "tavily_search",
        credential: "tavily-secret",
      },
      { context: org.context },
    );
    const enabled = await call(
      capabilitiesRouter.routes.put,
      { capabilityKey: "web.fetch", chain: ["tavily"] },
      { context: org.context },
    );
    expect(enabled).toMatchObject({
      capabilityKey: "web.fetch",
      chain: ["tavily"],
    });

    const disabled = await call(
      capabilitiesRouter.routes.put,
      { capabilityKey: "web.fetch", chain: [] },
      { context: org.context },
    );
    expect(disabled).toBeNull();
    await expect(
      call(capabilitiesRouter.routes.list, {}, { context: org.context }),
    ).resolves.toEqual([]);
  });

  it("stores and routes a credential-free embedded provider", async () => {
    const org = await createOrg();
    const ddgs = await call(
      capabilitiesRouter.providers.put,
      {
        name: "ddgs",
        label: "DDGS",
        driverKey: "ddgs",
        settings: {},
      },
      { context: org.context },
    );

    expect(ddgs).toMatchObject({
      hasCredential: false,
      capabilities: ["web.search", "web.fetch"],
      settings: {},
    });
    await expect(
      call(
        capabilitiesRouter.routes.put,
        { capabilityKey: "web.fetch", chain: ["ddgs"] },
        { context: org.context },
      ),
    ).resolves.toMatchObject({ chain: ["ddgs"] });
  });

  it("refuses a provider on a route for the wrong capability", async () => {
    const org = await createOrg();
    await call(
      capabilitiesRouter.providers.put,
      {
        name: "brave",
        driverKey: "brave_search",
        credential: "brave-secret",
      },
      { context: org.context },
    );

    await expect(
      call(
        capabilitiesRouter.routes.put,
        { capabilityKey: "web.fetch", chain: ["brave"] },
        { context: org.context },
      ),
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });
  });
});
