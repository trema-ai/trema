import type { ModelEndpoint } from "@trema/models";
import { AwsV4Signer } from "aws4fetch";
import { GoogleAuth } from "google-auth-library";
import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
} from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { resolveProviderTransport } from "#server/services/model-providers/index.js";

/** What one probe learned. A failure carries a sentence an admin can act on. */
export type ModelProviderProbeResult =
  | { ok: true; latencyMs: number; modelCount?: number }
  | { ok: false; reason: string };

/** One model a provider listed, plus whatever capability it stated about it. */
export interface RemoteModel {
  id: string;
  /**
   * Whether the listing said this model answers with vectors. Absent when the
   * listing said nothing a reader can trust, which is most of them: the
   * OpenAI-compatible listing shape carries no capability field.
   */
  embedding?: boolean;
}

/** The models a provider says it serves, as it names them. */
export type RemoteModelListResult =
  | { ok: true; latencyMs: number; models: RemoteModel[] }
  | { ok: false; reason: string };

/** Long enough for a cold gateway, short enough that the screen is not left waiting. */
const defaultTimeoutMs = 10_000;

export interface RemoteCallOptions {
  masterKey?: string;
  timeoutMs?: number;
  fetch?: typeof globalThis.fetch;
}

/**
 * What a failed connection is called, by the code the transport attaches. The
 * error's own message is never used: a header the transport refuses is reported
 * with the offending value inline, and that value can be the credential.
 */
const connectionReasons: Record<string, string> = {
  ECONNREFUSED: "Nothing is listening at the provider's base URL.",
  ENOTFOUND: "The provider's host name did not resolve.",
  EAI_AGAIN: "The provider's host name did not resolve.",
  ECONNRESET: "The provider closed the connection before answering.",
  ETIMEDOUT: "The connection to the provider timed out.",
  CERT_HAS_EXPIRED: "The provider's TLS certificate was rejected.",
  DEPTH_ZERO_SELF_SIGNED_CERT: "The provider's TLS certificate was rejected.",
  UNABLE_TO_VERIFY_LEAF_SIGNATURE: "The provider's TLS certificate was rejected.",
};

function causeCode(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  if (typeof cause === "object" && cause !== null && "code" in cause) {
    const code = (cause as { code?: unknown }).code;
    if (typeof code === "string") return code;
  }
  return undefined;
}

function unreachableReason(error: unknown, timeoutMs: number): string {
  const name = error instanceof Error ? error.name : "";
  if (name === "TimeoutError" || name === "AbortError") {
    const limit = timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} seconds` : `${timeoutMs} ms`;
    return `The provider did not answer within ${limit}.`;
  }
  const code = causeCode(error);
  return (
    (code === undefined ? undefined : connectionReasons[code]) ??
    "The provider could not be reached. Check the base URL, the stored headers, and the credential."
  );
}

/** A failed call is never read, and an unread body holds its socket open. */
async function discard(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

/** The call one protocol's model listing is made with, or why it cannot be made. */
type ListingRequest =
  | { ok: true; url: string; headers: Record<string, string> }
  | { ok: false; reason: string };

/**
 * How each protocol asks for its model list: the address it answers at, and the
 * headers that authenticate the ask. It used to be two records, a URL and a
 * header set, which held while every protocol spent its credential the same
 * way. Signing broke that: an address and its headers are computed together
 * there, from the same key, and the computation is asynchronous. So there is
 * one builder per protocol now, and the protocol is still the branch key —
 * never a vendor.
 *
 * A builder may refuse: a call it cannot authenticate is a sentence an admin
 * can act on, not an unsigned request the provider will reject with a 403.
 *
 * A builder is handed the same fetch the listing itself will use, because one
 * protocol authenticates by asking somebody else first: a token exchange is
 * another call, and it belongs on the same wire as the one it authorizes.
 */
type ListingRequestBuilders = {
  [Protocol in ModelEndpoint["protocol"]]: (
    endpoint: Extract<ModelEndpoint, { protocol: Protocol }>,
    query: string,
    call: typeof globalThis.fetch,
  ) => ListingRequest | Promise<ListingRequest>;
};

/** Appends the stored listing query, which most rows leave empty. */
function withQuery(url: string, query: string): string {
  return query === "" ? url : `${url}?${query}`;
}

/**
 * The control-plane host that answers `ListFoundationModels` for a region.
 * Bedrock splits its API in two: a runtime host serves model calls, and this
 * one serves the catalog. The runtime address is what a row stores, so the
 * listing derives its counterpart.
 */
function bedrockControlPlaneUrl(baseUrl: string, region: string): string {
  const runtime = new URL(baseUrl);
  // Swapping the leading label keeps everything the admin put after it, which
  // is what a partition other than the commercial one needs: the China suffix
  // rides through untouched. Any other host is a customer's own gateway or a
  // VPC endpoint, and a host that proxies the runtime API says nothing about
  // serving the catalog one, so the region's own control-plane host is the
  // honest guess. The tradeoff is stated rather than hidden: against a private
  // deployment that listing fails legibly, which is better than asking a
  // gateway for a path it never claimed to serve. Such a deployment can still
  // keep its catalog by hand.
  const derived = runtime.hostname.startsWith("bedrock-runtime.")
    ? `${runtime.protocol}//${runtime.hostname.replace(/^bedrock-runtime\./, "bedrock.")}`
    : `https://bedrock.${region}.amazonaws.com`;
  return `${derived}/foundation-models`;
}

const listingRequests: ListingRequestBuilders = {
  "openai-compatible": (endpoint, query) => ({
    ok: true,
    url: withQuery(`${endpoint.baseUrl}/models`, query),
    headers: endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` },
  }),
  anthropic: (endpoint, query) => ({
    ok: true,
    url: withQuery(`${endpoint.baseUrl}/models`, query),
    headers: {
      "anthropic-version": "2023-06-01",
      ...(endpoint.apiKey === undefined ? {} : { "x-api-key": endpoint.apiKey }),
    },
  }),
  google: (endpoint, query) => ({
    ok: true,
    url: withQuery(`${endpoint.baseUrl}/models`, query),
    headers: endpoint.apiKey === undefined ? {} : { "x-goog-api-key": endpoint.apiKey },
  }),
  // The Responses surface keeps the OpenAI-shaped listing beside it, so the
  // path is the same one and the answer parses as the same `data` array.
  "openai-responses": (endpoint, query) => ({
    ok: true,
    url: withQuery(`${endpoint.baseUrl}/models`, query),
    headers: endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` },
  }),
  bedrock: async (endpoint, query) => {
    // Only this row's own credential is ever spent. The run path may sign with
    // the worker's ambient role, through the SDK; a listing speaks for one
    // registry row, and signing it with somebody else's identity would report
    // on a catalog the row cannot reach.
    if (endpoint.accessKeyId === undefined || endpoint.secretAccessKey === undefined) {
      return {
        ok: false,
        reason:
          "Reading this provider's models needs stored AWS keys. Enter them, then refresh the model list.",
      };
    }
    const url = withQuery(bedrockControlPlaneUrl(endpoint.baseUrl, endpoint.region), query);
    // The stored headers are signed with the rest: added afterwards they would
    // travel outside the signature, which is a difference worth not having.
    const signer = new AwsV4Signer({
      method: "GET",
      url,
      headers: endpoint.headers ?? {},
      region: endpoint.region,
      service: "bedrock",
      accessKeyId: endpoint.accessKeyId,
      secretAccessKey: endpoint.secretAccessKey,
      ...(endpoint.sessionToken === undefined ? {} : { sessionToken: endpoint.sessionToken }),
    });
    const signed = await signer.sign();
    return { ok: true, url, headers: Object.fromEntries(signed.headers) };
  },
  vertex: async (endpoint, query, call) => {
    // Only this row's own credential is ever spent, for the reason the Bedrock
    // builder above gives: the run path may let the provider fall back to the
    // worker's own application-default credential, but a listing speaks for one
    // registry row, and borrowing the server's identity would report on a
    // catalog the row cannot reach.
    if (endpoint.serviceAccount === undefined) {
      return {
        ok: false,
        reason:
          "Reading this provider's models needs a stored service account. Add one, then refresh the model list.",
      };
    }
    // The exchange rides the same fetch the listing will, so a deployment that
    // routes this module's egress routes all of it.
    const auth = new GoogleAuth({
      scopes: ["https://www.googleapis.com/auth/cloud-platform"],
      credentials: {
        client_email: endpoint.serviceAccount.clientEmail,
        private_key: endpoint.serviceAccount.privateKey,
      },
      clientOptions: { transporterOptions: { fetchImplementation: call } },
    });
    let token: string | null | undefined;
    try {
      token = await auth.getAccessToken();
    } catch {
      // The exchange failing is this provider's answer, not a crash: a key that
      // has been revoked, or a clock too far off to sign with, reads the same
      // way to an admin as a listing that came back empty-handed.
      return { ok: false, reason: "The stored service account could not be exchanged for a token" };
    }
    if (!token) {
      return { ok: false, reason: "The stored service account could not be exchanged for a token" };
    }
    return {
      // Model Garden's publisher listing, which is what this protocol has that
      // is both cheap and authenticated. It hangs off the stored base URL like
      // every other protocol's listing does — no project in the path, because
      // the catalog is the publisher's and the token says whose quota reads it.
      ok: true,
      url: withQuery(`${endpoint.baseUrl}/publishers/google/models`, query),
      headers: { authorization: `Bearer ${token}` },
    };
  },
};

/**
 * Picks the builder the endpoint's protocol names. The cast is what TypeScript
 * cannot see for itself: the record's keys and its parameter types come from
 * the same union, so the builder found under a protocol takes exactly the
 * endpoint that carries it.
 */
function listingRequest(
  endpoint: ModelEndpoint,
  query: string,
  call: typeof globalThis.fetch,
): ListingRequest | Promise<ListingRequest> {
  const build = listingRequests[endpoint.protocol] as (
    endpoint: ModelEndpoint,
    query: string,
    call: typeof globalThis.fetch,
  ) => ListingRequest | Promise<ListingRequest>;
  return build(endpoint, query, call);
}

/** A model list that came back, or the sentence explaining why it did not. */
type ListingResult = { ok: true; latencyMs: number; body: unknown } | { ok: false; reason: string };

/**
 * The one call both screens make: the provider's own model listing, fetched
 * with the stored credential. It is the cheapest authenticated request the
 * protocol has, which is why it serves as the health check as well.
 *
 * On demand only, at both call sites: providers rate-limit, and a background
 * poll would spend the customer's quota on a screen nobody is looking at.
 *
 * Every failure is a returned sentence this module wrote. The transport's own
 * error messages are never repeated — a header it refuses is reported with the
 * offending value inline, and that value can be the credential.
 */
async function listModels(
  db: Database,
  orgId: string,
  name: string,
  options: RemoteCallOptions,
): Promise<ListingResult> {
  const timeoutMs = options.timeoutMs ?? defaultTimeoutMs;
  let transport: Awaited<ReturnType<typeof resolveProviderTransport>>;
  try {
    transport = await resolveProviderTransport(db, orgId, name, {
      ...(options.masterKey === undefined ? {} : { masterKey: options.masterKey }),
    });
  } catch (error) {
    if (
      error instanceof CredentialDecryptionError ||
      error instanceof CredentialEncryptionConfigError
    ) {
      log.warn("Model provider credential unreadable", { providerName: name, error });
      return {
        ok: false,
        reason: "The stored credential cannot be read. Enter it again to replace it.",
      };
    }
    throw error;
  }

  const { endpoint, listQuery } = transport;
  // The stored query is the row's own, seeded by whatever preset created it, so
  // no vendor is named here. The base URL carries none of its own — it is
  // refused a query string at write time — which is what makes appending safe.
  const query = new URLSearchParams(listQuery).toString();
  const call = options.fetch ?? globalThis.fetch;
  const request = await listingRequest(endpoint, query, call);
  if (!request.ok) return request;

  const started = performance.now();
  let response: Response;
  try {
    response = await call(request.url, {
      method: "GET",
      headers: {
        ...request.headers,
        ...endpoint.headers,
      },
      // Nothing is followed: a redirect to another host would carry the stored
      // headers there, and the admin should point the base URL at whatever
      // answers instead.
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    log.warn("Model provider call failed", {
      providerName: name,
      errorName: error instanceof Error ? error.name : "unknown",
      ...(causeCode(error) === undefined ? {} : { code: causeCode(error) }),
    });
    return { ok: false, reason: unreachableReason(error, timeoutMs) };
  }
  const latencyMs = Math.round(performance.now() - started);

  if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) {
    await discard(response);
    return {
      ok: false,
      reason:
        "The provider answered with a redirect. Set the base URL to the address it points at.",
    };
  }
  if (response.status === 401 || response.status === 403) {
    await discard(response);
    return { ok: false, reason: `The provider rejected the credential (HTTP ${response.status}).` };
  }
  if (!response.ok) {
    await discard(response);
    return { ok: false, reason: `The provider answered with HTTP ${response.status}.` };
  }

  try {
    return { ok: true, latencyMs, body: await response.json() };
  } catch {
    // Parsing consumes the stream, so this is belt and braces — every failure
    // branch here leaves the socket released, and none is left to inference.
    await discard(response);
    return {
      ok: false,
      reason: "The provider answered with something other than JSON, so its models are unreadable.",
    };
  }
}

/**
 * The array a listing puts its models in, or undefined when it has none. Four
 * names are read in one pass rather than per vendor: `data`, which the
 * OpenAI-compatible shape uses, `models`, which the Gemini API uses,
 * `modelSummaries`, which Bedrock's foundation-model listing uses, and
 * `publisherModels`, which Vertex's Model Garden listing uses.
 */
function listedEntries(body: unknown): unknown[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const shaped = body as {
    data?: unknown;
    models?: unknown;
    modelSummaries?: unknown;
    publisherModels?: unknown;
  };
  if (Array.isArray(shaped.data)) return shaped.data;
  if (Array.isArray(shaped.models)) return shaped.models;
  if (Array.isArray(shaped.modelSummaries)) return shaped.modelSummaries;
  return Array.isArray(shaped.publisherModels) ? shaped.publisherModels : undefined;
}

/**
 * What a resource name puts in front of the model's own id. Two listings
 * address models as resources and neither takes the prefix back on the wire:
 * the Gemini API names a model `models/gemini-2.0-flash`, and Vertex's Model
 * Garden qualifies the same thing by its publisher,
 * `publishers/google/models/gemini-2.5-flash`. Only those two shapes come off,
 * so an id that happens to contain the word survives intact.
 */
const resourcePrefixPattern = /^(?:publishers\/[^/]+\/)?models\//;

/**
 * The id a listing entry goes by, as the wire protocol will take it back. An
 * entry may name itself `id`, `modelId`, or, where the listing addresses models
 * as resources, `name` — and a resource name is path-qualified, so the
 * collection prefix comes off. What is stored has to be what a request can put
 * on the wire.
 */
function listedId(entry: unknown): string | undefined {
  if (typeof entry === "string") return entry.trim() === "" ? undefined : entry.trim();
  if (typeof entry !== "object" || entry === null) return undefined;
  const shaped = entry as { id?: unknown; modelId?: unknown; name?: unknown };
  if (typeof shaped.id === "string" && shaped.id.trim() !== "") return shaped.id.trim();
  if (typeof shaped.modelId === "string" && shaped.modelId.trim() !== "") {
    return shaped.modelId.trim();
  }
  if (typeof shaped.name !== "string") return undefined;
  const name = shaped.name.trim().replace(resourcePrefixPattern, "");
  return name === "" ? undefined : name;
}

/**
 * The model categories a listing names, where it names any. Together documents
 * this exact vocabulary on its `type` field; a value outside it — a gateway
 * that writes `type: "model"` — is read as no statement at all rather than as
 * "not an embedder".
 */
const modelTypes: Record<string, boolean> = {
  chat: false,
  language: false,
  code: false,
  image: false,
  moderation: false,
  rerank: false,
  embedding: true,
  embeddings: true,
};

/**
 * What a listing entry says about producing vectors: true, false, or nothing.
 *
 * Four shapes carry it, and all are read in one pass rather than per vendor: a
 * top-level `type` (Together), `architecture.output_modalities` (OpenRouter),
 * `supportedGenerationMethods` (the Gemini API), and `outputModalities`
 * (Bedrock), where the presence of the embedding value in a stated list is a
 * yes and its absence from one is a no. An unrecognized shape yields
 * undefined — unknown, never "no" — so the screen falls back to reading the
 * model's name, which is all the plain OpenAI-compatible listing offers, and
 * all Vertex's publisher listing offers too: its entries describe console
 * actions and launch stages, never what a model produces.
 */
function embeddingHint(entry: Record<string, unknown>): boolean | undefined {
  const modalities = (entry.architecture as { output_modalities?: unknown } | undefined)
    ?.output_modalities;
  if (Array.isArray(modalities) && modalities.every((value) => typeof value === "string")) {
    return modalities.includes("embeddings");
  }
  const methods = entry.supportedGenerationMethods;
  if (Array.isArray(methods) && methods.every((value) => typeof value === "string")) {
    return methods.includes("embedContent");
  }
  // Bedrock states the modalities in capitals: TEXT, IMAGE, EMBEDDING.
  const outputs = entry.outputModalities;
  if (Array.isArray(outputs) && outputs.every((value) => typeof value === "string")) {
    return outputs.includes("EMBEDDING");
  }
  const type = entry.type;
  return typeof type === "string" ? modelTypes[type.toLowerCase()] : undefined;
}

/**
 * Asks a provider whether it is reachable and whether its credential still
 * works. The credential is spent on a transport header and never enters the
 * result; a credential the server cannot read is reported as a failed probe
 * rather than thrown, because "is this provider usable" is the question.
 */
export async function probeProvider(
  db: Database,
  orgId: string,
  name: string,
  options: RemoteCallOptions = {},
): Promise<ModelProviderProbeResult> {
  const listing = await listModels(db, orgId, name, options);
  if (!listing.ok) return listing;
  const listed = listedEntries(listing.body);
  log.info("Model provider probed", { providerName: name, latencyMs: listing.latencyMs });
  return {
    ok: true,
    latencyMs: listing.latencyMs,
    ...(listed === undefined ? {} : { modelCount: listed.length }),
  };
}

/**
 * Reads the models a provider offers. It is what a refresh writes the catalog
 * from, and it is read-only here: merging the answer with what is stored is
 * `catalog.ts`, which owns the rule for what an admin said about a model.
 */
export async function fetchRemoteModels(
  db: Database,
  orgId: string,
  name: string,
  options: RemoteCallOptions = {},
): Promise<RemoteModelListResult> {
  const listing = await listModels(db, orgId, name, options);
  if (!listing.ok) return listing;
  const listed = listedEntries(listing.body);
  if (listed === undefined) {
    return {
      ok: false,
      reason: "The provider answered without a model list, so there is nothing to import.",
    };
  }

  const models = new Map<string, RemoteModel>();
  for (const entry of listed) {
    const id = listedId(entry);
    if (id === undefined) continue;
    const shaped =
      typeof entry === "object" && entry !== null ? (entry as Record<string, unknown>) : undefined;
    const hint = shaped === undefined ? undefined : embeddingHint(shaped);
    models.set(id, { id, ...(hint === undefined ? {} : { embedding: hint }) });
  }
  const sorted = [...models.values()].sort((left, right) => (left.id < right.id ? -1 : 1));
  log.info("Model provider models listed", {
    providerName: name,
    latencyMs: listing.latencyMs,
    modelCount: sorted.length,
    embeddingCount: sorted.filter((model) => model.embedding === true).length,
  });
  return { ok: true, latencyMs: listing.latencyMs, models: sorted };
}
