import { describe, expect, it, vi } from "vitest";

import { createApp } from "#/app.js";
import type { Auth } from "#/lib/auth/index.js";
import type { Database } from "#/lib/db/index.js";
import { parseEnv } from "#/lib/env/schema.js";

const environment = parseEnv({
  NODE_ENV: "test",
  DATABASE_URL: "postgresql://localhost/trema_test",
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

    const response = await app.request("/api/system/ping");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      ok: true,
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
});
