import { createHmac } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";

import { createApp } from "#server/app.js";
import type { Auth } from "#server/lib/auth/index.js";
import type { Database } from "#server/lib/db/index.js";
import { parseEnv } from "#server/lib/env/schema.js";

const environment = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/trema_test",
  TREMA_MODE: "hosted",
  TREMA_AUTH_SECRET: "app-test-auth-secret-at-least-32-characters",
});

function databaseMock(
  query: () => Promise<unknown>,
  clientRegistrations: Array<Record<string, unknown>> = [],
): Database {
  return {
    $queryRaw: query,
    connectorConnection: { findMany: vi.fn().mockResolvedValue([]) },
    clientRegistration: { findMany: vi.fn().mockResolvedValue(clientRegistrations) },
  } as unknown as Database;
}

function authMock(handler = vi.fn()): Auth {
  return {
    handler,
  } as unknown as Auth;
}

function appDependencies(db: Database) {
  return {
    db,
    auth: authMock(),
    env: environment,
  };
}

describe("server", () => {
  it("reports liveness", async () => {
    const app = createApp(
      appDependencies(databaseMock(vi.fn().mockResolvedValue([{ "?column?": 1 }]))),
    );

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("verifies Slack deliveries and answers URL challenges", async () => {
    const signingSecret = "app-route-slack-signing-secret";
    const nowSeconds = Math.floor(Date.now() / 1_000);
    const body = JSON.stringify({ challenge: "challenge-1", type: "url_verification" });
    const signature = `v0=${createHmac("sha256", signingSecret)
      .update(`v0:${nowSeconds}:${body}`)
      .digest("hex")}`;
    const registration = {
      id: "01900000-0000-7000-8000-000000000001",
      orgId: "01900000-0000-7000-8000-000000000002",
      providerKey: "slack",
      source: "platform",
      clientId: null,
      clientSecretCiphertext: null,
      signingSecretCiphertext: null,
      sharedRef: "slack-app",
    };
    const app = createApp({
      ...appDependencies(databaseMock(vi.fn().mockResolvedValue([]), [registration])),
      platformApps: {
        get: () => ({
          clientId: "slack-client-id",
          clientSecret: "slack-client-secret",
          signingSecret,
        }),
      },
    });

    const response = await app.request("/api/v1/messaging/slack/events", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(nowSeconds),
        "x-slack-signature": signature,
      },
    });
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ challenge: "challenge-1" });

    const invalid = await app.request("/api/v1/messaging/slack/events", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "x-slack-request-timestamp": String(nowSeconds),
        "x-slack-signature": "v0=00",
      },
    });
    expect(invalid.status).toBe(401);
    await expect(invalid.text()).resolves.toBe("");
  });

  it("keeps Slack ingress closed when the UI has no signing secret configured", async () => {
    const app = createApp(appDependencies(databaseMock(vi.fn().mockResolvedValue([]))));

    const response = await app.request("/api/v1/messaging/slack/events", { method: "POST" });

    expect(response.status).toBe(503);
  });

  it.each(["events", "interactions"])(
    "caps streamed Slack %s webhook bodies before verification",
    async (route) => {
      const app = createApp(appDependencies(databaseMock(vi.fn().mockResolvedValue([]))));
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        cancel,
        pull(controller) {
          // The stream deliberately never closes. Three chunks exceed the
          // ingress cap, so the handler must stop reading and cancel it.
          controller.enqueue(new Uint8Array(400_000));
        },
      });
      const request = new Request(`https://trema.test/api/v1/messaging/slack/${route}`, {
        method: "POST",
        body,
        duplex: "half",
      } as RequestInit & { duplex: "half" });

      const response = await app.fetch(request);

      expect(response.status).toBe(413);
      await expect(response.text()).resolves.toBe("");
      expect(cancel).toHaveBeenCalledOnce();
    },
  );

  it("reports readiness when the database is reachable", async () => {
    const query = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const app = createApp(appDependencies(databaseMock(query)));

    const response = await app.request("/ready");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledOnce();
  });

  it("serves the oRPC router", async () => {
    const app = createApp(appDependencies(databaseMock(vi.fn().mockResolvedValue([]))));

    const response = await app.request("/rpc/system/ping", {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: "{}",
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      json: {
        ok: true,
      },
    });
  });

  it("serves the OpenAPI surface", async () => {
    const app = createApp(appDependencies(databaseMock(vi.fn().mockResolvedValue([]))));

    const response = await app.request("/api/v1/system/ping");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
    });
  });

  it("serves the OpenAPI document under the v1 prefix", async () => {
    const app = createApp(appDependencies(databaseMock(vi.fn().mockResolvedValue([]))));

    const response = await app.request("/api/v1/spec.json");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      info: { title: "Trema API" },
      servers: [{ url: "/api/v1" }],
    });
  });

  it("mounts the better-auth handler", async () => {
    const handler = vi.fn().mockResolvedValue(Response.json({ session: null }));
    const app = createApp({
      db: databaseMock(vi.fn().mockResolvedValue([])),
      auth: authMock(handler),
      env: environment,
    });

    const response = await app.request("/api/auth/get-session", {
      headers: {
        origin: "http://127.0.0.1:5173",
      },
    });

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ session: null });
    expect(response.headers.get("access-control-allow-credentials")).toBe("true");
    expect(handler).toHaveBeenCalledOnce();
  });

  it("reports unavailable when the database is unreachable", async () => {
    const app = createApp(
      appDependencies(databaseMock(vi.fn().mockRejectedValue(new Error("offline")))),
    );

    const response = await app.request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("returns a JSON response for unknown routes", async () => {
    const app = createApp(appDependencies(databaseMock(vi.fn().mockResolvedValue([]))));

    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });

  it("serves web assets and falls back to the SPA without masking server routes", async () => {
    const root = await mkdtemp(join(tmpdir(), "trema-web-"));
    await mkdir(join(root, "assets"));
    await writeFile(join(root, "index.html"), "<main>Trema app</main>");
    await writeFile(join(root, "assets", "app.js"), "console.log('trema')");
    const env = parseEnv({
      NODE_ENV: "test",
      DATABASE_URL: "postgresql://localhost/trema_test",
      TREMA_MODE: "hosted",
      TREMA_AUTH_SECRET: "app-test-auth-secret-at-least-32-characters",
      TREMA_WEB_DIST: root,
    });
    const app = createApp({ ...appDependencies(databaseMock(vi.fn().mockResolvedValue([]))), env });

    const asset = await app.request("/assets/app.js");
    expect(asset.status).toBe(200);
    await expect(asset.text()).resolves.toBe("console.log('trema')");
    const fallback = await app.request("/settings/members");
    expect(fallback.status).toBe(200);
    await expect(fallback.text()).resolves.toBe("<main>Trema app</main>");
    expect((await app.request("/health")).headers.get("content-type")).toContain(
      "application/json",
    );
    expect((await app.request("/rpc/missing")).status).toBe(404);
    expect((await app.request("/../package.json")).status).toBe(200);
    await expect((await app.request("/../package.json")).text()).resolves.toBe(
      "<main>Trema app</main>",
    );
  });
});
