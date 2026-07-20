import { describe, expect, it, vi } from "vitest";

import { createApp } from "./app.js";
import type { Database } from "./db.js";

function databaseMock(query: () => Promise<unknown>): Database {
  return {
    $queryRaw: query,
  } as unknown as Database;
}

describe("server", () => {
  it("reports liveness", async () => {
    const app = createApp({
      db: databaseMock(vi.fn().mockResolvedValue([{ "?column?": 1 }])),
    });

    const response = await app.request("/health");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
  });

  it("reports readiness when the database is reachable", async () => {
    const query = vi.fn().mockResolvedValue([{ "?column?": 1 }]);
    const app = createApp({ db: databaseMock(query) });

    const response = await app.request("/ready");

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ ok: true });
    expect(query).toHaveBeenCalledOnce();
  });

  it("serves the oRPC router", async () => {
    const app = createApp({
      db: databaseMock(vi.fn().mockResolvedValue([])),
    });

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

  it("reports unavailable when the database is unreachable", async () => {
    const app = createApp({
      db: databaseMock(vi.fn().mockRejectedValue(new Error("offline"))),
    });

    const response = await app.request("/ready");

    expect(response.status).toBe(503);
    await expect(response.json()).resolves.toEqual({ ok: false });
  });

  it("returns a JSON response for unknown routes", async () => {
    const app = createApp({
      db: databaseMock(vi.fn().mockResolvedValue([])),
    });

    const response = await app.request("/missing");

    expect(response.status).toBe(404);
    await expect(response.json()).resolves.toEqual({ error: "Not found" });
  });
});
