import {
  type InteractionSurfaceEvent,
  type MessageSurfaceEvent,
  SurfaceDriverError,
  type SurfaceEvent,
} from "@trema/chat";
import { SlackDriver, SlackIngressDriver } from "@trema/chat/slack";
import type { Engine, PrincipalRef } from "@trema/harness";

import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import {
  ConnectorReconnectRequiredError,
  NoClientRegistrationError,
  type PlatformAppDirectory,
  resolveClientRegistration,
  resolveConnectionCredential,
} from "#server/services/connectors/index.js";
import {
  resolveSlackRequest,
  SlackRequestRejectedError,
} from "#server/services/messaging/slack.js";
import {
  createRunServices,
  IntentMismatchError,
  IntentOptionError,
  IntentStateError,
  IntentTargetError,
  startRun,
  submitTargetIntent,
} from "#server/services/runs/index.js";

const SAFE_REJECTION =
  "Trema can't start work from this Slack account or conversation. Ask a Trema administrator to check the Slack connection, member link, and conversation binding.";
const SAFE_UNAVAILABLE =
  "Trema can't start work right now. Ask a Trema administrator to check the Slack connection.";

export interface SlackIngressAcknowledgement {
  challenge?: string;
}

export type SlackIngressNotice = (input: {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  directMessage: boolean;
  text: string;
}) => Promise<void>;

export interface SlackIngressOptions {
  db: Database;
  env: Environment;
  defer: (task: Promise<void>) => void;
  runEngineFor?: (orgId: string) => Engine;
  platformApps?: PlatformAppDirectory;
  fetch?: typeof globalThis.fetch;
  notify?: SlackIngressNotice;
  now?: () => number;
}

/** Tracks acknowledged webhook work so shutdown can drain it before exit. */
export class IngressWorkTracker {
  readonly #inFlight = new Set<Promise<void>>();

  defer(task: Promise<void>): void {
    const tracked = task
      .catch((error: unknown) => log.error("Deferred ingress work failed", { error }))
      .finally(() => this.#inFlight.delete(tracked));
    this.#inFlight.add(tracked);
  }

  get size(): number {
    return this.#inFlight.size;
  }

  async drain(timeoutMs: number): Promise<boolean> {
    const pending = [...this.#inFlight];
    if (pending.length === 0) return true;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => {
      timeout = setTimeout(() => resolve(false), timeoutMs);
    });
    const drained = Promise.allSettled(pending).then(() => true as const);
    const result = await Promise.race([drained, timedOut]);
    if (timeout !== undefined) clearTimeout(timeout);
    return result;
  }
}

/** Verifies and acknowledges Slack synchronously, then routes the fact separately. */
export class SlackIngressService {
  readonly #options: SlackIngressOptions;
  readonly #notify: SlackIngressNotice;

  constructor(options: SlackIngressOptions) {
    this.#options = options;
    this.#notify = options.notify ?? ((input) => this.#sendNotice(input));
  }

  async accept(request: Request): Promise<SlackIngressAcknowledgement> {
    const body = await request.text();
    const event = await this.#read(request, body);
    if (event.type === "challenge") return { challenge: event.challenge };
    if (event.type === "unsupported") {
      log.debug("Slack delivery ignored", { nativeKind: event.nativeType });
      return {};
    }
    this.#options.defer(this.#process(event));
    return {};
  }

  async #read(request: Request, body: string): Promise<SurfaceEvent> {
    const workspaceId = slackWorkspaceHint(body, request.headers.get("content-type"));
    const signingSecrets = await this.#signingSecrets(workspaceId);
    if (signingSecrets.length === 0) throw new SlackIngressConfigurationError();

    let invalidRequest: SurfaceDriverError | undefined;
    for (const signingSecret of signingSecrets) {
      const driver = new SlackIngressDriver({
        signingSecret,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      });
      try {
        return await driver.read(
          new Request(request.url, {
            method: request.method,
            headers: request.headers,
            body,
          }),
        );
      } catch (error) {
        if (error instanceof SurfaceDriverError && error.category === "invalid-request") {
          invalidRequest = error;
          continue;
        }
        throw error;
      }
    }
    throw invalidRequest ?? new SlackIngressConfigurationError();
  }

  async #signingSecrets(workspaceId: string | undefined): Promise<string[]> {
    const matchingConnections = workspaceId
      ? await this.#options.db.connectorConnection.findMany({
          where: {
            providerKey: "slack",
            config: { path: ["team.id"], equals: workspaceId },
          },
          select: { orgId: true },
        })
      : [];
    const registrations =
      matchingConnections.length > 0
        ? matchingConnections
        : await this.#options.db.clientRegistration.findMany({
            where: { providerKey: "slack" },
            select: { orgId: true },
            distinct: ["orgId"],
          });
    const secrets = new Set<string>();
    for (const orgId of new Set(registrations.map((registration) => registration.orgId))) {
      try {
        const registration = await resolveClientRegistration(
          this.#options.db,
          orgId,
          "slack",
          this.#options.platformApps,
          this.#options.env.TREMA_CREDENTIAL_MASTER_KEY,
        );
        if (registration.signingSecret) secrets.add(registration.signingSecret);
      } catch (error) {
        if (error instanceof NoClientRegistrationError) continue;
        throw error;
      }
    }
    return [...secrets];
  }

  async #process(event: Exclude<SurfaceEvent, { type: "challenge" | "unsupported" }>) {
    const startedAt = performance.now();
    try {
      if (event.type === "message") await this.#message(event);
      else await this.#interaction(event);
      log.info("Slack delivery processed", {
        nativeKind: event.type === "message" ? event.nativeKind : event.action.type,
        durationMs: Math.round(performance.now() - startedAt),
      });
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (error instanceof SlackRequestRejectedError) {
        if (error.reason === "bot_event") {
          log.debug("Slack bot delivery ignored", { durationMs });
          return;
        }
        log.warn("Slack delivery rejected", { reason: error.reason, durationMs });
        if (shouldNotify(error.reason)) await this.#safeNotice(event, SAFE_REJECTION);
        return;
      }
      if (
        error instanceof IntentMismatchError ||
        error instanceof IntentOptionError ||
        error instanceof IntentStateError ||
        error instanceof IntentTargetError ||
        error instanceof SlackTargetMismatchError
      ) {
        log.warn("Slack interaction rejected", { code: intentErrorCode(error), durationMs });
        await this.#safeNotice(event, SAFE_REJECTION);
        return;
      }
      log.error("Slack delivery processing failed", { error, durationMs });
      await this.#safeNotice(event, SAFE_UNAVAILABLE);
    }
  }

  async #message(event: MessageSurfaceEvent): Promise<void> {
    const request = await this.#resolve(event);
    // Slack fans a mentioned channel reply out as both `message` and
    // `app_mention`. The mention is canonical; discard its message shadow.
    if (
      event.nativeKind === "thread-reply" &&
      request.botUserId !== null &&
      event.text.includes(`<@${request.botUserId}>`)
    ) {
      return;
    }
    const engine = this.#options.runEngineFor?.(request.orgId);
    if (engine === undefined) throw new SlackRunSchedulingUnavailableError();
    const text = stripBotMention(event.text, request.botUserId);
    if (text.length === 0) return;
    const services = createRunServices({
      db: this.#options.db,
      env: this.#options.env,
      orgId: request.orgId,
      engine,
    });
    const author: PrincipalRef = {
      principalId: request.requesterPrincipalId,
      displayName: request.requesterDisplayName,
    };
    await startRun({
      services,
      input: {
        intentId: event.intentId,
        trigger: "message",
        surface: "slack",
        locationRef: request.locationRef,
        threadRef: event.surfaceRef.threadRef,
        ...(event.nativeKind === "direct-message"
          ? {
              directMessage: true,
              requester: { externalUserId: request.externalUserId } as const,
            }
          : { requester: { principalId: request.requesterPrincipalId } as const }),
        author,
        message: { role: "user", blocks: [{ type: "text", text }] },
      },
    });
  }

  async #interaction(event: InteractionSurfaceEvent): Promise<void> {
    if (event.action.type === "native" || event.surfaceRef === undefined) return;
    const request = await this.#resolve(event);
    const engine = this.#options.runEngineFor?.(request.orgId);
    if (engine === undefined) throw new SlackRunSchedulingUnavailableError();
    const services = createRunServices({
      db: this.#options.db,
      env: this.#options.env,
      orgId: request.orgId,
      engine,
    });
    const by: PrincipalRef = {
      principalId: request.requesterPrincipalId,
      displayName: request.requesterDisplayName,
    };
    if (event.action.type === "resolve") {
      await requireSlackElicitationTarget(this.#options.db, {
        orgId: request.orgId,
        elicitationId: event.action.elicitationId,
        locationRef: request.locationRef,
        threadRef: event.surfaceRef.threadRef,
      });
      await submitTargetIntent({
        services,
        input: { intentId: event.intentId, by, intent: event.action },
      });
      return;
    }
    if (request.runId === null || request.runId !== event.action.runId) {
      throw new SlackTargetMismatchError();
    }
    await submitTargetIntent({
      services,
      input: { intentId: event.intentId, by, intent: event.action },
    });
  }

  #resolve(event: MessageSurfaceEvent | InteractionSurfaceEvent) {
    const surfaceRef = event.surfaceRef;
    if (surfaceRef === undefined || surfaceRef.teamRef === undefined) {
      throw new SlackRequestRejectedError("not_installed");
    }
    return resolveSlackRequest(this.#options.db, {
      workspaceId: surfaceRef.teamRef,
      channelId: surfaceRef.channelRef,
      threadTs: surfaceRef.threadRef,
      userId: event.authorRef,
      directMessage: surfaceRef.channelRef.startsWith("D"),
      ...(this.#options.env.TREMA_CREDENTIAL_MASTER_KEY
        ? { masterKey: this.#options.env.TREMA_CREDENTIAL_MASTER_KEY }
        : {}),
      ...(this.#options.platformApps === undefined
        ? {}
        : { platformApps: this.#options.platformApps }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    });
  }

  async #safeNotice(
    event: MessageSurfaceEvent | InteractionSurfaceEvent,
    text: string,
  ): Promise<void> {
    if (event.surfaceRef === undefined || event.surfaceRef.teamRef === undefined) return;
    await this.#notify({
      workspaceId: event.surfaceRef.teamRef,
      channelId: event.surfaceRef.channelRef,
      threadTs: event.surfaceRef.threadRef,
      userId: event.authorRef,
      directMessage: event.surfaceRef.channelRef.startsWith("D"),
      text,
    }).catch(() => {
      // Provider failures can retain request objects containing credentials.
      // Report only that the safe response failed, never the error object.
      log.warn("Slack rejection response failed");
    });
  }

  async #sendNotice(input: Parameters<SlackIngressNotice>[0]): Promise<void> {
    const connection = await this.#options.db.connectorConnection.findFirst({
      where: {
        providerKey: "slack",
        revokedAt: null,
        config: { path: ["team.id"], equals: input.workspaceId },
        owner: { kind: "agent", deactivatedAt: null },
      },
      select: { id: true, orgId: true },
    });
    if (connection === null) return;
    let resolved: Awaited<ReturnType<typeof resolveConnectionCredential>>;
    try {
      resolved = await resolveConnectionCredential(this.#options.db, {
        orgId: connection.orgId,
        connectionId: connection.id,
        ...(this.#options.env.TREMA_CREDENTIAL_MASTER_KEY
          ? { masterKey: this.#options.env.TREMA_CREDENTIAL_MASTER_KEY }
          : {}),
        ...(this.#options.platformApps === undefined
          ? {}
          : { platformApps: this.#options.platformApps }),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
      });
    } catch (error) {
      if (error instanceof ConnectorReconnectRequiredError) return;
      throw error;
    }
    const token = resolved.credential.accessToken;
    if (typeof token !== "string" || token.length === 0) return;
    const driver = new SlackDriver({
      token,
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    });
    if (input.directMessage) {
      await driver.callNative("chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
      });
      return;
    }
    await driver.callNative("chat.postEphemeral", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      user: input.userId,
      text: input.text,
    });
  }
}

export class SlackIngressConfigurationError extends Error {
  constructor() {
    super("No Slack signing secret is configured for this delivery");
    this.name = "SlackIngressConfigurationError";
  }
}

class SlackRunSchedulingUnavailableError extends Error {}

class SlackTargetMismatchError extends Error {
  readonly code = "target_mismatch";
}

function shouldNotify(reason: SlackRequestRejectedError["reason"]): boolean {
  return (
    reason === "identity_unlinked" ||
    reason === "location_unbound" ||
    reason === "personal_scopes_disabled" ||
    reason === "connector_mismatch"
  );
}

function intentErrorCode(error: Error): string {
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

function stripBotMention(text: string, botUserId: string | null): string {
  if (botUserId === null) return text.trim();
  return text.replace(new RegExp(`<@${botUserId}>`, "gu"), "").trim();
}

function slackWorkspaceHint(body: string, contentType: string | null): string | undefined {
  let payload: unknown;
  try {
    payload = contentType?.includes("application/x-www-form-urlencoded")
      ? JSON.parse(new URLSearchParams(body).get("payload") ?? "null")
      : JSON.parse(body);
  } catch {
    return undefined;
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const record = payload as Record<string, unknown>;
  const direct = record.team_id;
  const team = record.team;
  const nested =
    typeof team === "object" && team !== null && !Array.isArray(team)
      ? (team as Record<string, unknown>).id
      : undefined;
  const candidate = typeof direct === "string" ? direct : nested;
  return typeof candidate === "string" && /^[A-Z][A-Z0-9]{1,31}$/.test(candidate)
    ? candidate
    : undefined;
}

async function requireSlackElicitationTarget(
  db: Database,
  input: { orgId: string; elicitationId: string; locationRef: string; threadRef: string },
): Promise<void> {
  const elicitation = await db.runElicitation.findUnique({
    where: { orgId_id: { orgId: input.orgId, id: input.elicitationId } },
    select: {
      run: {
        select: {
          session: { select: { surface: true, locationRef: true, threadRef: true } },
        },
      },
    },
  });
  const session = elicitation?.run.session;
  if (
    session?.surface !== "slack" ||
    session.locationRef !== input.locationRef ||
    session.threadRef !== input.threadRef
  ) {
    throw new SlackTargetMismatchError();
  }
}
