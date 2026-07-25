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

function databaseMock(query: () => Promise<unknown>): Database {
  return {
    $queryRaw: query,
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
