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
}

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

async function callSearchProvider(
  provider: ResolvedCapabilityProvider,
  input: z.infer<typeof searchWebInputSchema>,
  fetchImpl: typeof fetch,
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
      return { results };
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

async function callFetchProvider(
  provider: ResolvedCapabilityProvider,
  url: URL,
  fetchImpl: typeof fetch,
): Promise<WebFetchResponse> {
  try {
    if (provider.driverKey !== "tavily_search") {
      throw new WebProviderError(provider.name);
    }
    const response = await fetchImpl("https://api.tavily.com/extract", {
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
    const truncated = result.raw_content.length > FETCH_URL_MAX_CHARACTERS;
    return {
      url: result.url,
      contentType: "text/markdown",
      text: result.raw_content.slice(0, FETCH_URL_MAX_CHARACTERS),
      truncated,
    };
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
    try {
      const fetched = await callFetchProvider(
        provider,
        url,
        options.providerFetch ?? globalThis.fetch,
      );
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
    } catch (error) {
      const failure =
        error instanceof WebProviderError ? error : new WebProviderError(provider.name);
      failures.push(failure);
      log.warn("Web fetch provider failed", {
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
