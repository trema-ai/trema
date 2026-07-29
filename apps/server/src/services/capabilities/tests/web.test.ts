import type { CapabilityProvider, Prisma } from "#server/generated/prisma/client.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import {
  fetchPublicWebPage,
  fetchUrl,
  htmlToText,
  isPublicAddress,
  searchWeb,
} from "#server/services/capabilities/web.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";
import { describe, expect, it, vi } from "vitest";

const masterKey = Buffer.alloc(32, 7).toString("base64");
const now = new Date("2026-07-29T12:00:00.000Z");
const session: DataPlaneSession = {
  id: "session-1",
  orgId: "org-1",
  scopeId: "scope-1",
  scopeKind: "org",
  scopeChain: ["scope-1"],
  actingPrincipalId: "agent-1",
  requesterPrincipalId: "person-1",
  requesterExternalRef: null,
  approvalMode: "ask",
  policyRows: [],
};

function provider(
  name: string,
  driverKey: string,
  credential?: string,
  settingsJson: Prisma.JsonObject = {},
): CapabilityProvider {
  return {
    id: `${name}-id`,
    orgId: "org-1",
    name,
    label: name,
    driverKey,
    settingsJson,
    credentialCiphertext:
      credential === undefined ? null : encryptEnvelope(credential, masterKey),
    createdAt: now,
    updatedAt: now,
  };
}

function fakeDb(
  routes: Record<string, string[]>,
  providers: CapabilityProvider[],
): Database & { auditLog: { create: ReturnType<typeof vi.fn> } } {
  const auditCreate = vi.fn(async () => ({}));
  return {
    capabilityRoute: {
      findUnique: async ({
        where,
      }: {
        where: { orgId_capabilityKey: { capabilityKey: string } };
      }) => {
        const capabilityKey = where.orgId_capabilityKey.capabilityKey;
        const chain = routes[capabilityKey];
        return chain
          ? {
              id: `${capabilityKey}-route`,
              orgId: "org-1",
              capabilityKey,
              chainJson: chain,
              createdAt: now,
              updatedAt: now,
            }
          : null;
      },
    },
    capabilityProvider: {
      findMany: async () => providers,
    },
    auditLog: { create: auditCreate },
  } as unknown as Database & { auditLog: { create: ReturnType<typeof vi.fn> } };
}

describe("web capabilities", () => {
  it("extracts readable text and drops executable markup", () => {
    const extracted = htmlToText(`
      <html>
        <head><title>Example &amp; test</title><style>.hidden {}</style></head>
        <body><main><h1>Hello</h1><p>One&nbsp;line.</p><script>steal()</script></main></body>
      </html>
    `);

    expect(extracted).toEqual({
      title: "Example & test",
      text: "Hello\nOne line.",
    });
  });

  it("refuses private and reserved addresses", () => {
    for (const address of [
      "127.0.0.1",
      "10.0.0.1",
      "169.254.169.254",
      "192.168.1.1",
      "198.51.100.10",
      "::1",
      "fd00::1",
      "fe80::1",
    ]) {
      expect(isPublicAddress(address), address).toBe(false);
    }
    expect(isPublicAddress("8.8.8.8")).toBe(true);
    expect(isPublicAddress("2606:4700:4700::1111")).toBe(true);
  });

  it("rejects a loopback fetch before opening a connection", async () => {
    await expect(
      fetchPublicWebPage(new URL("http://127.0.0.1/private"), {
        timeoutMs: 1_000,
        maxBytes: 16_384,
        maxCharacters: 1_000,
      }),
    ).rejects.toMatchObject({ code: "private_network_refused" });
  });

  it("falls through to the next search provider and normalizes its result", async () => {
    const db = fakeDb(
      { "web.search": ["brave", "tavily"] },
      [
        provider("brave", "brave_search", "brave-key"),
        provider("tavily", "tavily_search", "tavily-key"),
      ],
    );
    const calls: Array<{ url: string; authorization?: string }> = [];
    const providerFetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const authorization = new Headers(init?.headers).get("authorization") ?? undefined;
      calls.push({ url, ...(authorization === undefined ? {} : { authorization }) });
      if (url.startsWith("https://api.search.brave.com/")) {
        return new Response("unavailable", { status: 503 });
      }
      return Response.json({
        results: [
          {
            title: "Trema",
            url: "https://trema.ai/",
            content: "The AI agent your company owns.",
            published_date: "2026-07-29",
          },
        ],
      });
    });

    const searched = await searchWeb(
      db,
      session,
      { query: "Trema", limit: 3 },
      { masterKey, providerFetch: providerFetch as typeof fetch },
    );

    expect(searched).toEqual({
      results: [
        {
          title: "Trema",
          url: "https://trema.ai/",
          snippet: "The AI agent your company owns.",
          publishedAt: "2026-07-29",
        },
      ],
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toMatchObject({ authorization: "Bearer tavily-key" });
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "dataplane.search_web",
          payload: expect.objectContaining({ providerName: "tavily", resultCount: 1 }),
        }),
      }),
    );
  });

  it("extracts and truncates a fetched HTML page under the configured route", async () => {
    const db = fakeDb(
      { "web.fetch": ["builtin-fetch"] },
      [
        provider("builtin-fetch", "builtin_web_fetch", undefined, {
          timeoutMs: 2_000,
          maxBytes: 20_000,
          maxCharacters: 1_000,
        }),
      ],
    );

    const fetched = await fetchUrl(
      db,
      session,
      { url: "https://example.com/article" },
      {
        publicPageFetch: async (url) => ({
          url,
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
          body: Buffer.from(`<title>Article</title><p>${"a".repeat(1_200)}</p>`),
        }),
      },
    );

    expect(fetched).toEqual({
      url: "https://example.com/article",
      title: "Article",
      contentType: "text/html",
      text: "a".repeat(1_000),
      truncated: true,
    });
  });
});
