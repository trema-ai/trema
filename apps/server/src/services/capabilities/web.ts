import {
  type SearchOptions as DuckDuckGoSearchOptions,
  type SearchResponse as DuckDuckGoSearchResponse,
  search as searchDuckDuckGo,
} from "ddg-search";
import { z } from "zod";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type ResolvedCapabilityProvider,
  resolveCapabilityProviders,
} from "#server/services/capabilities/index.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";

export const SEARCH_WEB_DEFAULT_LIMIT = 8;
export const SEARCH_WEB_MAX_LIMIT = 20;

export const searchWebInputSchema = z.object({
  query: z.string().trim().min(1).max(400).describe("What to search for on the public web."),
  limit: z
    .number()
    .int()
    .min(1)
    .max(SEARCH_WEB_MAX_LIMIT)
    .optional()
    .describe(`Maximum results. Defaults to ${SEARCH_WEB_DEFAULT_LIMIT}.`),
  recency: z
    .enum(["day", "week", "month", "year"])
    .optional()
    .describe("Only return pages published or updated within this period."),
});

export const fetchUrlInputSchema = z.object({
  url: z
    .url()
    .describe("The public HTTP or HTTPS URL to read. Private-network addresses are refused."),
});

export interface WebSearchResult {
  title: string;
  url: string;
  snippet: string;
  publishedAt?: string;
}

export interface WebSearchResponse {
  provider: string;
  results: WebSearchResult[];
}

export interface WebFetchResponse {
  url: string;
  title?: string;
  contentType: string;
  text: string;
  truncated: boolean;
}

export interface WebCapabilityExecutionOptions {
  masterKey?: string;
  providerFetch?: typeof fetch;
  ddgsSearch?: DuckDuckGoSearch;
}

type DuckDuckGoSearch = (
  query: string,
  options: DuckDuckGoSearchOptions,
) => Promise<DuckDuckGoSearchResponse>;

export class WebCapabilityError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "WebCapabilityError";
  }
}

class WebProviderError extends Error {
  constructor(
    readonly providerName: string,
    readonly status?: number,
  ) {
    super("Web capability provider failed");
    this.name = "WebProviderError";
  }
}

function boundedLimit(limit: number | undefined): number {
  return Math.min(Math.max(limit ?? SEARCH_WEB_DEFAULT_LIMIT, 1), SEARCH_WEB_MAX_LIMIT);
}

function namedEntity(entity: string): string | undefined {
  return {
    amp: "&",
    apos: "'",
    gt: ">",
    hellip: "…",
    ldquo: "“",
    lsquo: "‘",
    lt: "<",
    nbsp: " ",
    ndash: "–",
    quot: '"',
    rdquo: "”",
    rsquo: "’",
  }[entity];
}

function decodeHtmlEntities(value: string): string {
  return value.replace(/&(#(?:x[0-9a-f]+|\d+)|[a-z]+);/gi, (match, entity: string) => {
    if (entity.startsWith("#x") || entity.startsWith("#X")) {
      const code = Number.parseInt(entity.slice(2), 16);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    if (entity.startsWith("#")) {
      const code = Number.parseInt(entity.slice(1), 10);
      return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
        ? String.fromCodePoint(code)
        : match;
    }
    return namedEntity(entity.toLowerCase()) ?? match;
  });
}

/** Extract readable text without executing or preserving markup. */
export function htmlToText(html: string): { title?: string; text: string } {
  const titleMatch = html.match(/<title\b[^>]*>([\s\S]*?)<\/title>/i);
  const title = titleMatch
    ? decodeHtmlEntities(titleMatch[1]!.replace(/<[^>]+>/g, " "))
        .replace(/\s+/g, " ")
        .trim()
    : undefined;
  const text = decodeHtmlEntities(
    html
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<(script|style|svg|noscript|template|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|main|aside|header|footer|h[1-6]|li|tr)>/gi, "\n")
      .replace(/<li\b[^>]*>/gi, "\n- ")
      .replace(/<[^>]+>/g, " "),
  )
    .split(/\r?\n/)
    .map((line) => line.replace(/[ \t\f\v]+/g, " ").trim())
    .filter(Boolean)
    .join("\n");
  return { ...(title ? { title } : {}), text };
}

function checkedWebUrl(value: string | URL): URL {
  const url = value instanceof URL ? new URL(value) : new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new WebCapabilityError("unsupported_url_scheme", "Only HTTP and HTTPS URLs can be read");
  }
  if (url.username !== "" || url.password !== "") {
    throw new WebCapabilityError(
      "url_credentials_refused",
      "URLs containing credentials cannot be read",
    );
  }
  return url;
}

async function responseText(
  response: Response,
  providerName: string,
  maxBytes = 1_000_000,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new WebProviderError(providerName, response.status);
  }
  if (response.body === null) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > maxBytes) {
      await reader.cancel();
      throw new WebProviderError(providerName, response.status);
    }
    chunks.push(value);
  }
  const merged = new Uint8Array(bytes);
  let offset = 0;
  for (const chunk of chunks) {
    merged.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(merged);
}

function parseJson(text: string, providerName: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new WebProviderError(providerName);
  }
}

const braveResponseSchema = z.object({
  web: z
    .object({
      results: z.array(
        z.object({
          title: z.string(),
          url: z.url(),
          description: z.string().default(""),
          age: z.string().optional(),
        }),
      ),
    })
    .optional(),
});

const tavilyResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string(),
      url: z.url(),
      content: z.string().default(""),
      published_date: z.string().optional(),
    }),
  ),
});

const tavilyExtractResponseSchema = z.object({
  results: z.array(
    z.object({
      url: z.url(),
      raw_content: z.string(),
    }),
  ),
  failed_results: z.array(z.object({ url: z.url() })).default([]),
});

const firecrawlSearchResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    web: z
      .array(
        z.object({
          title: z.string().default(""),
          url: z.url(),
          description: z.string().default(""),
        }),
      )
      .default([]),
  }),
});

const firecrawlScrapeResponseSchema = z.object({
  success: z.boolean(),
  data: z.object({
    markdown: z.string(),
    metadata: z
      .object({
        title: z.string().optional(),
        sourceURL: z.url().optional(),
        url: z.url().optional(),
      })
      .passthrough()
      .default({}),
  }),
});

const searxngResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().default(""),
      url: z.url(),
      content: z.string().default(""),
      publishedDate: z.string().nullish(),
    }),
  ),
});

const ddgsSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().default(""),
      url: z.url(),
      description: z.string().default(""),
    }),
  ),
});

const exaSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.url(),
      publishedDate: z.string().nullish(),
      text: z.string().optional(),
      highlights: z.array(z.string()).optional(),
      summary: z.string().optional(),
    }),
  ),
});

const exaContentsResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.url(),
      text: z.string(),
    }),
  ),
});

const parallelSearchResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.url(),
      publish_date: z.string().nullish(),
      excerpts: z.array(z.string()).default([]),
    }),
  ),
});

const parallelExtractResponseSchema = z.object({
  results: z.array(
    z.object({
      title: z.string().nullish(),
      url: z.url(),
      excerpts: z.array(z.string()).default([]),
      full_content: z.string().nullish(),
    }),
  ),
});

function providerEndpoint(provider: ResolvedCapabilityProvider, path: string): string {
  const baseUrl = provider.settings.baseUrl;
  if (typeof baseUrl !== "string") throw new WebProviderError(provider.name);
  return new URL(path.replace(/^\/+/, ""), `${baseUrl.replace(/\/+$/, "")}/`).toString();
}

function recencyStart(
  recency: z.infer<typeof searchWebInputSchema>["recency"],
): string | undefined {
  if (recency === undefined) return undefined;
  const days = { day: 1, week: 7, month: 30, year: 365 }[recency];
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
}

async function callSearchProvider(
  provider: ResolvedCapabilityProvider,
  input: z.infer<typeof searchWebInputSchema>,
  fetchImpl: typeof fetch,
  ddgsSearch: DuckDuckGoSearch,
): Promise<WebSearchResult[]> {
  const limit = boundedLimit(input.limit);
  const signal = AbortSignal.timeout(15_000);
  let response: Response;
  try {
    if (provider.driverKey === "brave_search") {
      const url = new URL("https://api.search.brave.com/res/v1/web/search");
      url.searchParams.set("q", input.query);
      url.searchParams.set("count", String(limit));
      url.searchParams.set("result_filter", "web");
      url.searchParams.set("text_decorations", "false");
      url.searchParams.set("safesearch", "moderate");
      if (input.recency) {
        url.searchParams.set(
          "freshness",
          { day: "pd", week: "pw", month: "pm", year: "py" }[input.recency],
        );
      }
      response = await fetchImpl(url, {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": provider.credential!,
        },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = braveResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new WebProviderError(provider.name);
      return (parsed.data.web?.results ?? []).slice(0, limit).map((result) => ({
        title: htmlToText(result.title).text,
        url: result.url,
        snippet: htmlToText(result.description).text,
        ...(result.age ? { publishedAt: result.age } : {}),
      }));
    }
    if (provider.driverKey === "tavily_search") {
      response = await fetchImpl("https://api.tavily.com/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${provider.credential!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          search_depth: "basic",
          max_results: limit,
          include_answer: false,
          include_raw_content: false,
          include_images: false,
          safe_search: true,
          ...(input.recency ? { time_range: input.recency } : {}),
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = tavilyResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new WebProviderError(provider.name);
      return parsed.data.results.slice(0, limit).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
        ...(result.published_date ? { publishedAt: result.published_date } : {}),
      }));
    }
    if (provider.driverKey === "firecrawl") {
      response = await fetchImpl("https://api.firecrawl.dev/v2/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${provider.credential!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          query: input.query,
          limit,
          sources: ["web"],
          highlights: false,
          ...(input.recency
            ? { tbs: `qdr:${{ day: "d", week: "w", month: "m", year: "y" }[input.recency]}` }
            : {}),
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = firecrawlSearchResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success || !parsed.data.success) throw new WebProviderError(provider.name);
      return parsed.data.data.web.slice(0, limit).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.description,
      }));
    }
    if (provider.driverKey === "searxng") {
      const url = new URL(providerEndpoint(provider, "search"));
      url.searchParams.set("q", input.query);
      url.searchParams.set("format", "json");
      url.searchParams.set("safesearch", "1");
      if (input.recency && input.recency !== "week") {
        url.searchParams.set("time_range", input.recency);
      }
      response = await fetchImpl(url, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = searxngResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new WebProviderError(provider.name);
      return parsed.data.results.slice(0, limit).map((result) => ({
        title: htmlToText(result.title).text,
        url: result.url,
        snippet: htmlToText(result.content).text,
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      }));
    }
    if (provider.driverKey === "ddgs") {
      const raw = await ddgsSearch(input.query, {
        maxPages: 1,
        maxResults: limit,
        region: "",
        time:
          input.recency === undefined
            ? ""
            : { day: "d", week: "w", month: "m", year: "y" }[input.recency],
        signal,
        fetchImpl,
        stderr: { isTTY: false, write: () => true },
      });
      const parsed = ddgsSearchResponseSchema.safeParse(raw);
      if (!parsed.success) throw new WebProviderError(provider.name);
      return parsed.data.results.slice(0, limit).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.description,
      }));
    }
    if (provider.driverKey === "exa") {
      response = await fetchImpl("https://api.exa.ai/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": provider.credential!,
        },
        body: JSON.stringify({
          query: input.query,
          numResults: limit,
          contents: { highlights: true },
          ...(input.recency ? { startPublishedDate: recencyStart(input.recency) } : {}),
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = exaSearchResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new WebProviderError(provider.name);
      return parsed.data.results.slice(0, limit).map((result) => ({
        title: result.title ?? result.url,
        url: result.url,
        snippet: result.highlights?.join("\n") ?? result.summary ?? result.text ?? "",
        ...(result.publishedDate ? { publishedAt: result.publishedDate } : {}),
      }));
    }
    if (provider.driverKey === "parallel") {
      response = await fetchImpl("https://api.parallel.ai/v1/search", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": provider.credential!,
        },
        body: JSON.stringify({
          objective: input.query,
          search_queries: [input.query],
          mode: "basic",
          max_chars_total: Math.max(2_000, limit * 1_000),
          advanced_settings: {
            max_results: limit,
            ...(input.recency
              ? { source_policy: { after_date: recencyStart(input.recency)!.slice(0, 10) } }
              : {}),
          },
        }),
        redirect: "error",
        signal,
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = parallelSearchResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new WebProviderError(provider.name);
      return parsed.data.results.slice(0, limit).map((result) => ({
        title: result.title ?? result.url,
        url: result.url,
        snippet: result.excerpts.join("\n"),
        ...(result.publish_date ? { publishedAt: result.publish_date } : {}),
      }));
    }
    throw new WebProviderError(provider.name);
  } catch (error) {
    if (error instanceof WebProviderError) throw error;
    throw new WebProviderError(provider.name);
  }
}

export async function searchWeb(
  db: Database,
  session: DataPlaneSession,
  input: z.infer<typeof searchWebInputSchema>,
  options: WebCapabilityExecutionOptions = {},
): Promise<WebSearchResponse> {
  const providers = await resolveCapabilityProviders(db, {
    orgId: session.orgId,
    capabilityKey: "web.search",
    ...(options.masterKey ? { masterKey: options.masterKey } : {}),
  });
  if (providers.length === 0) {
    throw new WebCapabilityError(
      "web_search_unavailable",
      "Web search is not configured for this organization",
    );
  }
  const startedAt = performance.now();
  const failures: WebProviderError[] = [];
  for (const provider of providers) {
    try {
      const results = await callSearchProvider(
        provider,
        input,
        options.providerFetch ?? globalThis.fetch,
        options.ddgsSearch ?? searchDuckDuckGo,
      );
      await db.auditLog.create({
        data: {
          orgId: session.orgId,
          actorPrincipalId: session.actingPrincipalId,
          action: "dataplane.search_web",
          subject: session.id,
          payload: {
            providerName: provider.name,
            resultCount: results.length,
            limit: boundedLimit(input.limit),
            recency: input.recency ?? null,
          },
        },
      });
      log.info("Web searched", {
        sessionId: session.id,
        providerName: provider.name,
        resultCount: results.length,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return { provider: provider.label, results };
    } catch (error) {
      const failure =
        error instanceof WebProviderError ? error : new WebProviderError(provider.name);
      failures.push(failure);
      log.warn("Web search provider failed", {
        sessionId: session.id,
        providerName: provider.name,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
    }
  }
  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "dataplane.search_web",
      subject: session.id,
      payload: {
        outcome: "failed",
        providerCount: failures.length,
        statuses: failures.map(({ providerName, status }) => ({
          providerName,
          status: status ?? null,
        })),
      },
    },
  });
  throw new WebCapabilityError("web_search_failed", "Every configured web search provider failed");
}

const FETCH_URL_MAX_CHARACTERS = 50_000;

function boundedFetchResponse(url: string, text: string, title?: string): WebFetchResponse {
  return {
    url,
    ...(title ? { title } : {}),
    contentType: "text/markdown",
    text: text.slice(0, FETCH_URL_MAX_CHARACTERS),
    truncated: text.length > FETCH_URL_MAX_CHARACTERS,
  };
}

async function callFetchProvider(
  provider: ResolvedCapabilityProvider,
  url: URL,
  fetchImpl: typeof fetch,
): Promise<WebFetchResponse> {
  try {
    let response: Response;
    if (provider.driverKey === "tavily_search") {
      response = await fetchImpl("https://api.tavily.com/extract", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${provider.credential!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          urls: url.toString(),
          extract_depth: "basic",
          include_images: false,
          include_favicon: false,
          format: "markdown",
          timeout: 15,
          include_usage: false,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = tavilyExtractResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new WebProviderError(provider.name);
      const result = parsed.data.results[0];
      if (result === undefined) throw new WebProviderError(provider.name);
      return boundedFetchResponse(result.url, result.raw_content);
    }
    if (provider.driverKey === "firecrawl") {
      response = await fetchImpl("https://api.firecrawl.dev/v2/scrape", {
        method: "POST",
        headers: {
          Accept: "application/json",
          Authorization: `Bearer ${provider.credential!}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          url: url.toString(),
          formats: ["markdown"],
          onlyMainContent: true,
          removeBase64Images: true,
          blockAds: true,
          timeout: 15_000,
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = firecrawlScrapeResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success || !parsed.data.success) throw new WebProviderError(provider.name);
      return boundedFetchResponse(
        parsed.data.data.metadata.sourceURL ?? parsed.data.data.metadata.url ?? url.toString(),
        parsed.data.data.markdown,
        parsed.data.data.metadata.title,
      );
    }
    if (provider.driverKey === "ddgs") {
      response = await fetchImpl(url, {
        headers: {
          Accept: "text/html, text/plain;q=0.9",
          "User-Agent": "Trema/1.0",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const contentType = response.headers.get("content-type")?.toLowerCase() ?? "";
      if (!contentType.includes("text/html") && !contentType.includes("text/plain")) {
        throw new WebProviderError(provider.name, response.status);
      }
      const extracted = htmlToText(await responseText(response, provider.name));
      if (extracted.text === "") throw new WebProviderError(provider.name);
      return boundedFetchResponse(response.url || url.toString(), extracted.text, extracted.title);
    }
    if (provider.driverKey === "exa") {
      response = await fetchImpl("https://api.exa.ai/contents", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": provider.credential!,
        },
        body: JSON.stringify({ urls: [url.toString()], text: true }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = exaContentsResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success || parsed.data.results[0] === undefined) {
        throw new WebProviderError(provider.name);
      }
      const result = parsed.data.results[0];
      return boundedFetchResponse(result.url, result.text, result.title ?? undefined);
    }
    if (provider.driverKey === "parallel") {
      response = await fetchImpl("https://api.parallel.ai/v1/extract", {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "x-api-key": provider.credential!,
        },
        body: JSON.stringify({
          urls: [url.toString()],
          objective: "Return the complete readable content of this page.",
          max_chars_total: FETCH_URL_MAX_CHARACTERS,
          advanced_settings: {
            full_content: { max_chars_per_result: FETCH_URL_MAX_CHARACTERS },
          },
        }),
        redirect: "error",
        signal: AbortSignal.timeout(20_000),
      });
      if (!response.ok) throw new WebProviderError(provider.name, response.status);
      const parsed = parallelExtractResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success || parsed.data.results[0] === undefined) {
        throw new WebProviderError(provider.name);
      }
      const result = parsed.data.results[0];
      return boundedFetchResponse(
        result.url,
        result.full_content ?? result.excerpts.join("\n\n"),
        result.title ?? undefined,
      );
    }
    throw new WebProviderError(provider.name);
  } catch (error) {
    if (error instanceof WebProviderError) throw error;
    throw new WebProviderError(provider.name);
  }
}

export async function fetchUrl(
  db: Database,
  session: DataPlaneSession,
  input: z.infer<typeof fetchUrlInputSchema>,
  options: WebCapabilityExecutionOptions = {},
): Promise<WebFetchResponse> {
  const providers = await resolveCapabilityProviders(db, {
    orgId: session.orgId,
    capabilityKey: "web.fetch",
    ...(options.masterKey ? { masterKey: options.masterKey } : {}),
  });
  if (providers.length === 0) {
    throw new WebCapabilityError(
      "web_fetch_unavailable",
      "Web fetch is not configured for this organization",
    );
  }
  const url = checkedWebUrl(input.url);
  const startedAt = performance.now();
  const failures: WebProviderError[] = [];
  for (const provider of providers) {
    let fetched: WebFetchResponse;
    try {
      fetched = await callFetchProvider(provider, url, options.providerFetch ?? globalThis.fetch);
    } catch (error) {
      const failure =
        error instanceof WebProviderError ? error : new WebProviderError(provider.name);
      failures.push(failure);
      log.warn("Web fetch provider failed", {
        sessionId: session.id,
        providerName: provider.name,
        ...(failure.status === undefined ? {} : { status: failure.status }),
      });
      continue;
    }
    await db.auditLog.create({
      data: {
        orgId: session.orgId,
        actorPrincipalId: session.actingPrincipalId,
        action: "dataplane.fetch_url",
        subject: session.id,
        payload: {
          providerName: provider.name,
          characters: fetched.text.length,
          truncated: fetched.truncated,
        },
      },
    });
    log.info("Web page fetched", {
      sessionId: session.id,
      providerName: provider.name,
      characters: fetched.text.length,
      truncated: fetched.truncated,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return fetched;
  }
  await db.auditLog.create({
    data: {
      orgId: session.orgId,
      actorPrincipalId: session.actingPrincipalId,
      action: "dataplane.fetch_url",
      subject: session.id,
      payload: {
        outcome: "failed",
        providerCount: failures.length,
        statuses: failures.map(({ providerName, status }) => ({
          providerName,
          status: status ?? null,
        })),
      },
    },
  });
  throw new WebCapabilityError("web_fetch_failed", "Every configured web fetch provider failed");
}
