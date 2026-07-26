import {
  CredentialDecryptionError,
  CredentialEncryptionConfigError,
} from "#server/lib/crypto/index.js";
import type { Database } from "#server/lib/db/index.js";
import { log } from "#server/lib/logger/index.js";
import { resolveProviderEndpoint } from "#server/services/model-providers/index.js";

/** What one probe learned. A failure carries a sentence an admin can act on. */
export type ModelProviderProbeResult =
  | { ok: true; latencyMs: number; modelCount?: number }
  | { ok: false; reason: string };

/** The models a provider says it serves, as it names them. */
export type RemoteModelListResult =
  | { ok: true; latencyMs: number; models: { id: string }[] }
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
  let endpoint: Awaited<ReturnType<typeof resolveProviderEndpoint>>;
  try {
    endpoint = await resolveProviderEndpoint(db, orgId, name, {
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

  // The listing call each protocol answers cheapest. A new protocol member adds
  // its line here rather than a branch further down.
  const listUrl: Record<typeof endpoint.protocol, string> = {
    "openai-compatible": `${endpoint.baseUrl}/models`,
  };

  const started = performance.now();
  const call = options.fetch ?? globalThis.fetch;
  let response: Response;
  try {
    response = await call(listUrl[endpoint.protocol], {
      method: "GET",
      headers: {
        ...(endpoint.apiKey === undefined ? {} : { authorization: `Bearer ${endpoint.apiKey}` }),
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

/** The `data` array of an OpenAI-shaped listing, or undefined when it has none. */
function listedEntries(body: unknown): unknown[] | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const data = (body as { data?: unknown }).data;
  return Array.isArray(data) ? data : undefined;
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
 * Reads the models a provider offers, for the catalog editor to import from.
 * The stored catalog stays the source of truth — this supplies ids, the admin
 * still owns which roles each model may serve.
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

  const ids = new Set<string>();
  for (const entry of listed) {
    const id = typeof entry === "object" && entry !== null ? (entry as { id?: unknown }).id : entry;
    if (typeof id === "string" && id.trim().length > 0) ids.add(id.trim());
  }
  log.info("Model provider models listed", {
    providerName: name,
    latencyMs: listing.latencyMs,
    modelCount: ids.size,
  });
  return {
    ok: true,
    latencyMs: listing.latencyMs,
    models: [...ids].sort().map((id) => ({ id })),
  };
}
