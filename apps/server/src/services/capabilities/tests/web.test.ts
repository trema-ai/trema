import { describe, expect, it, vi } from "vitest";
import type { CapabilityProvider, Prisma } from "#server/generated/prisma/client.js";
import { encryptEnvelope } from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { fetchUrl, htmlToText, searchWeb } from "#server/services/capabilities/web.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";

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
    credentialCiphertext: credential === undefined ? null : encryptEnvelope(credential, masterKey),
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

  it("falls through to the next search provider and normalizes its result", async () => {
    const db = fakeDb({ "web.search": ["brave", "tavily"] }, [
      provider("brave", "brave_search", "brave-key"),
      provider("tavily", "tavily_search", "tavily-key"),
    ]);
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
      provider: "tavily",
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

  it("normalizes Firecrawl, SearXNG, Exa, and Parallel search results", async () => {
    const cases = [
      {
        driverKey: "firecrawl",
        credential: "firecrawl-key",
        settings: {},
        response: {
          success: true,
          data: {
            web: [
              {
                title: "Firecrawl result",
                url: "https://example.com/firecrawl",
                description: "Firecrawl snippet",
              },
            ],
          },
        },
        expectedUrl: "https://api.firecrawl.dev/v2/search",
        result: {
          title: "Firecrawl result",
          url: "https://example.com/firecrawl",
          snippet: "Firecrawl snippet",
        },
      },
      {
        driverKey: "searxng",
        settings: { baseUrl: "http://searxng.internal:8080" },
        response: {
          results: [
            {
              title: "SearXNG result",
              url: "https://example.com/searxng",
              content: "SearXNG snippet",
              publishedDate: "2026-07-20",
            },
          ],
        },
        expectedUrl: "http://searxng.internal:8080/search",
        result: {
          title: "SearXNG result",
          url: "https://example.com/searxng",
          snippet: "SearXNG snippet",
          publishedAt: "2026-07-20",
        },
      },
      {
        driverKey: "exa",
        credential: "exa-key",
        settings: {},
        response: {
          results: [
            {
              title: "Exa result",
              url: "https://example.com/exa",
              highlights: ["Exa snippet"],
              publishedDate: "2026-07-21",
            },
          ],
        },
        expectedUrl: "https://api.exa.ai/search",
        result: {
          title: "Exa result",
          url: "https://example.com/exa",
          snippet: "Exa snippet",
          publishedAt: "2026-07-21",
        },
      },
      {
        driverKey: "parallel",
        credential: "parallel-key",
        settings: {},
        response: {
          results: [
            {
              title: "Parallel result",
              url: "https://example.com/parallel",
              excerpts: ["Parallel snippet"],
              publish_date: "2026-07-22",
            },
          ],
        },
        expectedUrl: "https://api.parallel.ai/v1/search",
        result: {
          title: "Parallel result",
          url: "https://example.com/parallel",
          snippet: "Parallel snippet",
          publishedAt: "2026-07-22",
        },
      },
    ] as const;

    for (const example of cases) {
      const db = fakeDb({ "web.search": ["provider"] }, [
        provider(
          "provider",
          example.driverKey,
          "credential" in example ? example.credential : undefined,
          example.settings,
        ),
      ]);
      const providerFetch = vi.fn(async (_input: string | URL | Request) =>
        Response.json(example.response),
      );

      await expect(
        searchWeb(
          db,
          session,
          { query: "current web result", limit: 2, recency: "week" },
          { masterKey, providerFetch: providerFetch as typeof fetch },
        ),
      ).resolves.toEqual({ provider: "provider", results: [example.result] });
      expect(String(providerFetch.mock.calls[0]![0])).toContain(example.expectedUrl);
    }
  });

  it("searches DDGS through the embedded library", async () => {
    const db = fakeDb({ "web.search": ["ddgs"] }, [provider("ddgs", "ddgs")]);
    const ddgsSearch = vi.fn(async () => ({
      noResults: false,
      vqd: "3-123-456",
      results: [
        {
          hostname: "example.com",
          url: "https://example.com/ddgs",
          title: "DDGS result",
          description: "DDGS snippet",
          rawDescription: "DDGS snippet",
          icon: "https://example.com/favicon.ico",
        },
      ],
    }));

    await expect(
      searchWeb(
        db,
        session,
        { query: "current web result", limit: 2, recency: "week" },
        { masterKey, ddgsSearch },
      ),
    ).resolves.toEqual({
      provider: "ddgs",
      results: [
        {
          title: "DDGS result",
          url: "https://example.com/ddgs",
          snippet: "DDGS snippet",
        },
      ],
    });
    expect(ddgsSearch).toHaveBeenCalledWith(
      "current web result",
      expect.objectContaining({ safeSearch: -1, time: "w" }),
    );
  });

  it("extracts and truncates a page through the configured Tavily route", async () => {
    const db = fakeDb({ "web.fetch": ["tavily"] }, [
      provider("tavily", "tavily_search", "tavily-key"),
    ]);
    const providerFetch = vi.fn(async () =>
      Response.json({
        results: [
          {
            url: "https://example.com/article",
            raw_content: "a".repeat(52_000),
          },
        ],
        failed_results: [],
      }),
    );

    const fetched = await fetchUrl(
      db,
      session,
      { url: "https://example.com/article" },
      { masterKey, providerFetch: providerFetch as typeof fetch },
    );

    expect(fetched).toEqual({
      url: "https://example.com/article",
      contentType: "text/markdown",
      text: "a".repeat(50_000),
      truncated: true,
    });
    expect(providerFetch).toHaveBeenCalledWith(
      "https://api.tavily.com/extract",
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"urls":"https://example.com/article"'),
      }),
    );
    expect(db.auditLog.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: "dataplane.fetch_url",
          payload: expect.objectContaining({ providerName: "tavily" }),
        }),
      }),
    );
  });

  it("normalizes Firecrawl, Exa, and Parallel extracts", async () => {
    const cases = [
      {
        driverKey: "firecrawl",
        credential: "firecrawl-key",
        settings: {},
        response: {
          success: true,
          data: {
            markdown: "# Firecrawl content",
            metadata: {
              title: "Firecrawl page",
              sourceURL: "https://example.com/article",
            },
          },
        },
        expectedUrl: "https://api.firecrawl.dev/v2/scrape",
        result: {
          url: "https://example.com/article",
          title: "Firecrawl page",
          contentType: "text/markdown",
          text: "# Firecrawl content",
          truncated: false,
        },
      },
      {
        driverKey: "exa",
        credential: "exa-key",
        settings: {},
        response: {
          results: [
            {
              title: "Exa page",
              url: "https://example.com/article",
              text: "Exa content",
            },
          ],
        },
        expectedUrl: "https://api.exa.ai/contents",
        result: {
          url: "https://example.com/article",
          title: "Exa page",
          contentType: "text/markdown",
          text: "Exa content",
          truncated: false,
        },
      },
      {
        driverKey: "parallel",
        credential: "parallel-key",
        settings: {},
        response: {
          results: [
            {
              title: "Parallel page",
              url: "https://example.com/article",
              excerpts: [],
              full_content: "Parallel content",
            },
          ],
        },
        expectedUrl: "https://api.parallel.ai/v1/extract",
        result: {
          url: "https://example.com/article",
          title: "Parallel page",
          contentType: "text/markdown",
          text: "Parallel content",
          truncated: false,
        },
      },
    ] as const;

    for (const example of cases) {
      const db = fakeDb({ "web.fetch": ["provider"] }, [
        provider(
          "provider",
          example.driverKey,
          "credential" in example ? example.credential : undefined,
          example.settings,
        ),
      ]);
      const providerFetch = vi.fn(async (_input: string | URL | Request) =>
        Response.json(example.response),
      );

      await expect(
        fetchUrl(
          db,
          session,
          { url: "https://example.com/article" },
          { masterKey, providerFetch: providerFetch as typeof fetch },
        ),
      ).resolves.toEqual(example.result);
      expect(String(providerFetch.mock.calls[0]![0])).toContain(example.expectedUrl);
    }
  });

  it("fetches and extracts a page through the embedded DDGS provider", async () => {
    const db = fakeDb({ "web.fetch": ["ddgs"] }, [provider("ddgs", "ddgs")]);
    const providerFetch = vi.fn(async () => {
      const response = new Response(
        "<html><head><title>DDGS page</title></head><body><main><h1>DDGS content</h1></main></body></html>",
        { headers: { "Content-Type": "text/html" } },
      );
      Object.defineProperty(response, "url", { value: "https://example.com/article" });
      return response;
    });

    await expect(
      fetchUrl(
        db,
        session,
        { url: "https://example.com/article" },
        { masterKey, providerFetch: providerFetch as typeof fetch },
      ),
    ).resolves.toEqual({
      url: "https://example.com/article",
      title: "DDGS page",
      contentType: "text/markdown",
      text: "DDGS content",
      truncated: false,
    });
    expect(providerFetch).toHaveBeenCalledWith(
      new URL("https://example.com/article"),
      expect.objectContaining({ redirect: "follow" }),
    );
  });

  it("does not retry a successful extract when audit logging fails", async () => {
    const db = fakeDb({ "web.fetch": ["primary", "fallback"] }, [
      provider("primary", "tavily_search", "primary-key"),
      provider("fallback", "tavily_search", "fallback-key"),
    ]);
    db.auditLog.create.mockRejectedValueOnce(new Error("audit unavailable"));
    const providerFetch = vi.fn(async () =>
      Response.json({
        results: [
          {
            url: "https://example.com/article",
            raw_content: "Extracted once.",
          },
        ],
        failed_results: [],
      }),
    );

    await expect(
      fetchUrl(
        db,
        session,
        { url: "https://example.com/article" },
        { masterKey, providerFetch: providerFetch as typeof fetch },
      ),
    ).rejects.toThrow("audit unavailable");

    expect(providerFetch).toHaveBeenCalledTimes(1);
  });
});
