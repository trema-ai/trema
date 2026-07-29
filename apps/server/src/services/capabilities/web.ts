import { lookup } from "node:dns/promises";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";

import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import {
  type BuiltinFetchSettings,
  resolveCapabilityProviders,
  type ResolvedCapabilityProvider,
} from "#server/services/capabilities/index.js";
import type { DataPlaneSession } from "#server/services/dataplane/index.js";
import { z } from "zod";

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
  publicPageFetch?: (
    url: URL,
    settings: BuiltinFetchSettings,
  ) => Promise<PublicWebResponse>;
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

class SearchProviderError extends Error {
  constructor(
    readonly providerName: string,
    readonly status?: number,
  ) {
    super("Search provider failed");
    this.name = "SearchProviderError";
  }
}

interface PublicWebResponse {
  url: URL;
  status: number;
  headers: Record<string, string | undefined>;
  body: Buffer;
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
      .replace(
        /<(script|style|svg|noscript|template|head|title)\b[^>]*>[\s\S]*?<\/\1>/gi,
        " ",
      )
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

function ipv4Number(address: string): number | undefined {
  const octets = address.split(".").map(Number);
  if (
    octets.length !== 4 ||
    octets.some((octet) => !Number.isInteger(octet) || octet < 0 || octet > 255)
  ) {
    return undefined;
  }
  return (((octets[0]! << 24) >>> 0) +
    (octets[1]! << 16) +
    (octets[2]! << 8) +
    octets[3]!) >>> 0;
}

function inIpv4Range(address: number, base: string, prefix: number): boolean {
  const baseNumber = ipv4Number(base)!;
  const mask = prefix === 0 ? 0 : (0xffffffff << (32 - prefix)) >>> 0;
  return (address & mask) === (baseNumber & mask);
}

const blockedIpv4Ranges = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
] as const;

/** True only for an address the public-web fetcher may connect to. */
export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  if (family === 4) {
    const value = ipv4Number(address);
    return (
      value !== undefined &&
      !blockedIpv4Ranges.some(([base, prefix]) => inIpv4Range(value, base, prefix))
    );
  }
  if (family !== 6) return false;
  const normalized = address.toLowerCase();
  const mapped = normalized.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/)?.[1];
  if (mapped) return isPublicAddress(mapped);
  if (normalized === "::" || normalized === "::1") return false;
  if (/^(fc|fd)/.test(normalized)) return false;
  if (/^fe[89ab]/.test(normalized)) return false;
  if (normalized.startsWith("ff")) return false;
  if (normalized.startsWith("2001:db8:")) return false;
  return true;
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

function headerValue(
  headers: Record<string, string | string[] | undefined>,
  name: string,
): string | undefined {
  const value = headers[name.toLowerCase()];
  return Array.isArray(value) ? value.join(", ") : value;
}

async function requestOnce(
  url: URL,
  settings: BuiltinFetchSettings,
): Promise<PublicWebResponse> {
  const addresses = await lookup(url.hostname, { all: true, verbatim: true });
  if (addresses.length === 0 || addresses.some(({ address }) => !isPublicAddress(address))) {
    throw new WebCapabilityError(
      "private_network_refused",
      "The URL resolves to a private or reserved network address",
    );
  }
  const target = addresses[0]!;
  const transport = url.protocol === "https:" ? httpsRequest : httpRequest;
  const defaultPort = url.protocol === "https:" ? "443" : "80";
  const hostHeader = url.port && url.port !== defaultPort ? `${url.hostname}:${url.port}` : url.hostname;

  return new Promise<PublicWebResponse>((resolve, reject) => {
    const request = transport(
      {
        protocol: url.protocol,
        hostname: target.address,
        family: target.family,
        port: url.port || defaultPort,
        path: `${url.pathname}${url.search}`,
        method: "GET",
        servername: url.hostname,
        headers: {
          Host: hostHeader,
          Accept: "text/html, application/xhtml+xml, text/plain, application/json;q=0.8",
          "Accept-Encoding": "identity",
          "User-Agent": "Trema/0.0 web-fetch",
        },
      },
      (response) => {
        const contentLength = Number(headerValue(response.headers, "content-length"));
        if (Number.isFinite(contentLength) && contentLength > settings.maxBytes) {
          response.destroy();
          reject(
            new WebCapabilityError(
              "response_too_large",
              `The page is larger than the configured ${settings.maxBytes} byte limit`,
            ),
          );
          return;
        }
        const chunks: Buffer[] = [];
        let bytes = 0;
        response.on("data", (chunk: Buffer | string) => {
          const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          bytes += buffer.length;
          if (bytes > settings.maxBytes) {
            response.destroy(
              new WebCapabilityError(
                "response_too_large",
                `The page is larger than the configured ${settings.maxBytes} byte limit`,
              ),
            );
            return;
          }
          chunks.push(buffer);
        });
        response.on("end", () => {
          resolve({
            url,
            status: response.statusCode ?? 0,
            headers: {
              location: headerValue(response.headers, "location"),
              "content-type": headerValue(response.headers, "content-type"),
            },
            body: Buffer.concat(chunks),
          });
        });
        response.on("error", reject);
      },
    );
    request.setTimeout(settings.timeoutMs, () => {
      request.destroy(new WebCapabilityError("fetch_timeout", "The page took too long to respond"));
    });
    request.on("error", reject);
    request.end();
  });
}

/** Fetch a public URL while pinning each DNS result and rechecking every redirect. */
export async function fetchPublicWebPage(
  initialUrl: URL,
  settings: BuiltinFetchSettings,
): Promise<PublicWebResponse> {
  let url = checkedWebUrl(initialUrl);
  for (let redirects = 0; redirects <= 5; redirects += 1) {
    const response = await requestOnce(url, settings);
    if (![301, 302, 303, 307, 308].includes(response.status)) return response;
    const location = response.headers.location;
    if (!location) {
      throw new WebCapabilityError("invalid_redirect", "The page returned an invalid redirect");
    }
    if (redirects === 5) {
      throw new WebCapabilityError("too_many_redirects", "The page redirected too many times");
    }
    url = checkedWebUrl(new URL(location, url));
  }
  throw new WebCapabilityError("too_many_redirects", "The page redirected too many times");
}

async function responseText(
  response: Response,
  providerName: string,
  maxBytes = 1_000_000,
): Promise<string> {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    throw new SearchProviderError(providerName, response.status);
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
      throw new SearchProviderError(providerName, response.status);
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
    throw new SearchProviderError(providerName);
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
      if (!response.ok) throw new SearchProviderError(provider.name, response.status);
      const parsed = braveResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new SearchProviderError(provider.name);
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
      if (!response.ok) throw new SearchProviderError(provider.name, response.status);
      const parsed = tavilyResponseSchema.safeParse(
        parseJson(await responseText(response, provider.name), provider.name),
      );
      if (!parsed.success) throw new SearchProviderError(provider.name);
      return parsed.data.results.slice(0, limit).map((result) => ({
        title: result.title,
        url: result.url,
        snippet: result.content,
        ...(result.published_date ? { publishedAt: result.published_date } : {}),
      }));
    }
    throw new SearchProviderError(provider.name);
  } catch (error) {
    if (error instanceof SearchProviderError) throw error;
    throw new SearchProviderError(provider.name);
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
  const failures: SearchProviderError[] = [];
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
        error instanceof SearchProviderError
          ? error
          : new SearchProviderError(provider.name);
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
  throw new WebCapabilityError(
    "web_search_failed",
    "Every configured web search provider failed",
  );
}

function contentType(headers: Record<string, string | undefined>): string {
  return (headers["content-type"] ?? "application/octet-stream").split(";", 1)[0]!.toLowerCase();
}

export async function fetchUrl(
  db: Database,
  session: DataPlaneSession,
  input: z.infer<typeof fetchUrlInputSchema>,
  options: WebCapabilityExecutionOptions = {},
): Promise<WebFetchResponse> {
  const [provider] = await resolveCapabilityProviders(db, {
    orgId: session.orgId,
    capabilityKey: "web.fetch",
    ...(options.masterKey ? { masterKey: options.masterKey } : {}),
  });
  if (provider === undefined || provider.driverKey !== "builtin_web_fetch") {
    throw new WebCapabilityError(
      "web_fetch_unavailable",
      "Web fetch is not configured for this organization",
    );
  }
  const settings = provider.settings as BuiltinFetchSettings;
  const startedAt = performance.now();
  try {
    const response = await (options.publicPageFetch ?? fetchPublicWebPage)(
      checkedWebUrl(input.url),
      settings,
    );
    if (response.status < 200 || response.status >= 300) {
      throw new WebCapabilityError(
        "web_fetch_http_error",
        `The page returned HTTP ${response.status}`,
      );
    }
    const type = contentType(response.headers);
    if (
      type !== "text/html" &&
      type !== "application/xhtml+xml" &&
      type !== "text/plain" &&
      type !== "application/json"
    ) {
      throw new WebCapabilityError(
        "unsupported_content_type",
        `The page returned unsupported content type ${type}`,
      );
    }
    const decoded = new TextDecoder("utf-8", { fatal: false }).decode(response.body);
    const extracted =
      type === "text/html" || type === "application/xhtml+xml"
        ? htmlToText(decoded)
        : { text: decoded.trim() };
    const truncated = extracted.text.length > settings.maxCharacters;
    const text = extracted.text.slice(0, settings.maxCharacters);
    await db.auditLog.create({
      data: {
        orgId: session.orgId,
        actorPrincipalId: session.actingPrincipalId,
        action: "dataplane.fetch_url",
        subject: session.id,
        payload: {
          status: response.status,
          contentType: type,
          bytes: response.body.byteLength,
          characters: text.length,
          truncated,
        },
      },
    });
    log.info("Web page fetched", {
      sessionId: session.id,
      status: response.status,
      contentType: type,
      bytes: response.body.byteLength,
      characters: text.length,
      truncated,
      durationMs: Math.round(performance.now() - startedAt),
    });
    return {
      url: response.url.toString(),
      ...(extracted.title ? { title: extracted.title } : {}),
      contentType: type,
      text,
      truncated,
    };
  } catch (error) {
    const code = error instanceof WebCapabilityError ? error.code : "web_fetch_failed";
    await db.auditLog.create({
      data: {
        orgId: session.orgId,
        actorPrincipalId: session.actingPrincipalId,
        action: "dataplane.fetch_url",
        subject: session.id,
        payload: { outcome: "failed", code },
      },
    });
    log.warn("Web page fetch failed", {
      sessionId: session.id,
      code,
      durationMs: Math.round(performance.now() - startedAt),
    });
    if (error instanceof WebCapabilityError) throw error;
    throw new WebCapabilityError("web_fetch_failed", "The page could not be fetched");
  }
}
