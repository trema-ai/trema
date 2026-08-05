import { createHash, randomUUID } from "node:crypto";

import {
  type InteractionSurfaceEvent,
  type MessageSurfaceEvent,
  SurfaceDriverError,
  type SurfaceEvent,
} from "@trema/chat";
import { SlackDriver, SlackIngressDriver } from "@trema/chat/slack";
import type { Engine, PrincipalRef } from "@trema/harness";

import type { Prisma } from "#server/generated/prisma/client.js";
import type { Database } from "#server/lib/db/index.js";
import type { Environment } from "#server/lib/env/schema.js";
import { log } from "#server/lib/logger/index.js";
import {
  ClientRegistrationNotFoundError,
  ConnectorReconnectRequiredError,
  NoClientRegistrationError,
  type PlatformAppDirectory,
  resolveClientRegistration,
  resolveConnectionCredential,
  resolveStoredClientRegistration,
} from "#server/services/connectors/index.js";
import { mintSlackIdentityLinkChallenge } from "#server/services/messaging/identity-link-challenge.js";
import {
  applySlackLifecycleEvent,
  resolveSlackRequest,
  SLACK_PROVIDER_KEY,
  type SlackLifecycleEvent,
  type SlackRequestRejectionContext,
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
const SLACK_INGRESS_LEASE_MS = 30_000;
const SLACK_INGRESS_RETRY_MS = 1_000;
const SLACK_INGRESS_TOMBSTONE_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;
const SLACK_INGRESS_PRUNE_INTERVAL_MS = 60 * 60 * 1_000;
const SLACK_THREAD_OWNERSHIP_WAIT_MS = 60_000;
const SLACK_WEBHOOK_MAX_BODY_BYTES = 1024 * 1024;
const SLACK_URL_VERIFICATION_MAX_BODY_BYTES = 16 * 1024;

type ProcessableSurfaceEvent = Exclude<SurfaceEvent, { type: "challenge" | "unsupported" }>;

type SlackIngressPayload =
  | { kind: "surface"; event: ProcessableSurfaceEvent; connectionIds: string[] }
  | { kind: "lifecycle"; event: SlackLifecycleEvent; connectionIds: string[] };

type VerifiedSlackEvent = { event: SurfaceEvent; connectionIds: string[] };
type SlackSigningCandidate = { signingSecret: string; connectionIds: string[] };
type SlackSigningSelector = { kind: "org" | "registration"; id: string };

type DeliveryOutcome = "completed" | "blocked" | "failed";

export interface SlackIngressAcknowledgement {
  challenge?: string;
}

export type SlackIngressNotice = (input: {
  workspaceId: string;
  channelId: string;
  threadTs: string;
  userId: string;
  directMessage: boolean;
  visibility: "private" | "channel";
  text: string;
  connectionIds?: readonly string[];
  orgId?: string;
  connectionId?: string;
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
  #recovery = Promise.resolve();
  #nextPruneAt = 0;
  #retryAt: number | undefined;
  #retryTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(options: SlackIngressOptions) {
    this.#options = options;
    this.#notify = options.notify ?? ((input) => this.#sendNotice(input));
  }

  async accept(request: Request): Promise<SlackIngressAcknowledgement> {
    const body = await readSlackWebhookBody(request);
    const verified = await this.#read(request, body);
    const event = verified.event;
    if (event.type === "challenge") return { challenge: event.challenge };
    if (event.type === "unsupported") {
      const lifecycle = slackLifecycleEvent(event.nativePayload);
      if (lifecycle !== undefined) {
        await this.#persist(slackLifecycleDeliveryId(event.nativePayload), {
          kind: "lifecycle",
          event: lifecycle,
          connectionIds: verified.connectionIds,
        });
        this.#options.defer(this.recoverPending());
        return {};
      }
      log.debug("Slack delivery ignored", { nativeKind: event.nativeType });
      return {};
    }
    await this.#persist(slackSurfaceDeliveryId(event), {
      kind: "surface",
      event,
      connectionIds: verified.connectionIds,
    });
    this.#options.defer(this.recoverPending());
    return {};
  }

  /** Replays every verified delivery that was not durably completed. */
  recoverPending(): Promise<void> {
    const recovery = this.#recovery
      .then(() => {
        this.#cancelScheduledRecovery();
        return this.#drainPending();
      })
      .catch((error: unknown) => {
        // Slack has already received 200 once a delivery reaches this path. A
        // failure before an individual delivery is claimed therefore needs its
        // own wake-up; a quiet deployment cannot rely on another webhook.
        this.#scheduleRecovery(new Date(Date.now() + SLACK_INGRESS_RETRY_MS));
        throw error;
      });
    this.#recovery = recovery.catch(() => undefined);
    return recovery;
  }

  #cancelScheduledRecovery(): void {
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryAt = undefined;
    this.#retryTimer = undefined;
  }

  async #persist(id: string, payload: SlackIngressPayload): Promise<void> {
    const threadKey = slackIngressThreadKey(payload);
    const nativeOrder = slackIngressNativeOrder(payload);
    await this.#options.db.slackIngressDelivery.createMany({
      data: [
        {
          id,
          opensThread: slackIngressOpensThread(payload),
          payload: payload as unknown as Prisma.InputJsonValue,
          ...(threadKey === undefined ? {} : { threadKey }),
          ...(nativeOrder === undefined ? {} : { nativeOrder }),
        },
      ],
      skipDuplicates: true,
    });
  }

  async #drainPending(): Promise<void> {
    await this.#pruneCompleted();
    let repeatBlocked = false;
    do {
      const now = new Date();
      const deliveries = await this.#options.db.slackIngressDelivery.findMany({
        where: {
          completedAt: null,
          OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
        },
        orderBy: [{ receivedAt: "asc" }, { id: "asc" }],
        select: { id: true },
      });
      let completed = false;
      for (const delivery of deliveries) {
        const outcome = await this.#processDelivery(delivery.id);
        if (outcome === "completed") completed = true;
      }
      repeatBlocked =
        completed &&
        (await this.#options.db.slackIngressDelivery.findFirst({
          where: { completedAt: null, leaseUntil: null },
          select: { id: true },
        })) !== null;
    } while (repeatBlocked);

    const leased = await this.#options.db.slackIngressDelivery.findFirst({
      where: { completedAt: null, leaseUntil: { gt: new Date() } },
      orderBy: { leaseUntil: "asc" },
      select: { leaseUntil: true },
    });
    if (leased?.leaseUntil !== null && leased?.leaseUntil !== undefined) {
      this.#scheduleRecovery(leased.leaseUntil);
    }
  }

  async #pruneCompleted(): Promise<void> {
    const now = Date.now();
    if (now < this.#nextPruneAt) return;
    this.#nextPruneAt = now + SLACK_INGRESS_PRUNE_INTERVAL_MS;
    try {
      const deleted = await this.#options.db.slackIngressDelivery.deleteMany({
        where: {
          completedAt: { lte: new Date(now - SLACK_INGRESS_TOMBSTONE_RETENTION_MS) },
        },
      });
      if (deleted.count > 0) {
        log.info("Expired Slack ingress tombstones pruned", { count: deleted.count });
      }
    } catch (error) {
      this.#nextPruneAt = 0;
      throw error;
    }
  }

  async #processDelivery(id: string): Promise<DeliveryOutcome> {
    const owner = randomUUID();
    const now = new Date();
    const claimed = await this.#options.db.slackIngressDelivery.updateMany({
      where: {
        id,
        completedAt: null,
        OR: [{ leaseUntil: null }, { leaseUntil: { lte: now } }],
      },
      data: {
        leaseOwner: owner,
        leaseUntil: new Date(now.getTime() + SLACK_INGRESS_LEASE_MS),
        attempt: { increment: 1 },
      },
    });
    if (claimed.count === 0) return "failed";
    const delivery = await this.#options.db.slackIngressDelivery.findUniqueOrThrow({
      where: { id },
      select: { attempt: true, payload: true, receivedAt: true, threadKey: true },
    });
    const payload = delivery.payload as unknown as SlackIngressPayload;
    try {
      const outcome =
        payload.kind === "lifecycle"
          ? await this.#processLifecycle(payload.event, payload.connectionIds)
          : await this.#process(payload.event, payload.connectionIds);
      if (outcome === "blocked") {
        const waitUntil = new Date(delivery.receivedAt.getTime() + SLACK_THREAD_OWNERSHIP_WAIT_MS);
        const owningDelivery =
          delivery.threadKey === null
            ? null
            : await this.#options.db.slackIngressDelivery.findFirst({
                where: {
                  id: { not: id },
                  completedAt: null,
                  opensThread: true,
                  threadKey: delivery.threadKey,
                },
                select: { id: true },
              });
        if (waitUntil.getTime() <= Date.now() && owningDelivery === null) {
          await this.#completeDelivery(id, owner);
          log.debug("Unowned Slack thread reply expired", { deliveryId: id });
          return "completed";
        }
        const nextCheck =
          waitUntil.getTime() > Date.now()
            ? waitUntil
            : new Date(Date.now() + SLACK_THREAD_OWNERSHIP_WAIT_MS);
        await this.#options.db.slackIngressDelivery.updateMany({
          where: { id, completedAt: null, leaseOwner: owner },
          data: { awaitingThread: true, leaseOwner: null, leaseUntil: nextCheck },
        });
        if (
          payload.kind === "surface" &&
          payload.event.type === "message" &&
          (await this.#resumeParkedReply(id, owner, payload.event, payload.connectionIds))
        ) {
          return "completed";
        }
        this.#scheduleRecovery(nextCheck);
        return "blocked";
      }
      await this.#completeDelivery(id, owner);
      return "completed";
    } catch (error) {
      const claimPending = error instanceof SlackRunClaimPendingError;
      const retryAt = new Date(Date.now() + ingressRetryDelay(delivery.attempt));
      await this.#options.db.slackIngressDelivery.updateMany({
        where: { id, completedAt: null, leaseOwner: owner },
        data: { awaitingThread: false, leaseOwner: null, leaseUntil: retryAt },
      });
      this.#scheduleRecovery(retryAt);
      if (claimPending) {
        log.debug("Slack ingress delivery awaits an existing run claim", { deliveryId: id });
      } else {
        log.error("Slack ingress delivery will retry", { error, deliveryId: id });
      }
      return "failed";
    }
  }

  async #completeDelivery(id: string, owner: string): Promise<void> {
    await this.#options.db.slackIngressDelivery.updateMany({
      where: { id, completedAt: null, leaseOwner: owner },
      data: {
        completedAt: new Date(),
        awaitingThread: false,
        leaseOwner: null,
        leaseUntil: null,
        // The id remains as the durable dedup tombstone; message content is
        // needed only while work is pending and is not retained afterward.
        payload: { kind: "completed" },
      },
    });
  }

  async #processLifecycle(
    event: SlackLifecycleEvent,
    connectionIds: readonly string[],
  ): Promise<"completed"> {
    await applySlackLifecycleEvent(
      this.#options.db,
      event,
      this.#options.env.TREMA_CREDENTIAL_MASTER_KEY,
      connectionIds,
    );
    return "completed";
  }

  #scheduleRecovery(at: Date): void {
    const timestamp = at.getTime();
    if (this.#retryAt !== undefined && this.#retryAt <= timestamp) return;
    if (this.#retryTimer !== undefined) clearTimeout(this.#retryTimer);
    this.#retryAt = timestamp;
    this.#retryTimer = setTimeout(
      () => {
        this.#retryAt = undefined;
        this.#retryTimer = undefined;
        this.#options.defer(this.recoverPending());
      },
      Math.max(0, timestamp - Date.now()),
    );
    this.#retryTimer.unref?.();
  }

  async #read(request: Request, body: string): Promise<VerifiedSlackEvent> {
    const hint = slackEnvelopeHint(body, request.headers.get("content-type"));
    const allowGlobalFallback = hint.urlVerification && hint.workspaceId === undefined;
    if (
      allowGlobalFallback &&
      Buffer.byteLength(body, "utf8") > SLACK_URL_VERIFICATION_MAX_BODY_BYTES
    ) {
      throw new SlackIngressBodyTooLargeError();
    }
    const signingSecrets = allowGlobalFallback
      ? await this.#selectedSigningSecret(slackRegistrationSelector(request.url))
      : await this.#signingSecrets(hint.workspaceId);
    if (signingSecrets.length === 0) throw new SlackIngressConfigurationError();

    let invalidRequest: SurfaceDriverError | undefined;
    for (const candidate of signingSecrets) {
      const driver = new SlackIngressDriver({
        signingSecret: candidate.signingSecret,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      });
      try {
        return {
          event: await driver.read(
            new Request(request.url, {
              method: request.method,
              headers: request.headers,
              body,
            }),
          ),
          connectionIds: candidate.connectionIds,
        };
      } catch (error) {
        if (error instanceof SurfaceDriverError && error.code === "invalid_request") {
          invalidRequest = error;
          continue;
        }
        throw error;
      }
    }
    throw invalidRequest ?? new SlackIngressConfigurationError();
  }

  async #selectedSigningSecret(
    selector: SlackSigningSelector | undefined,
  ): Promise<SlackSigningCandidate[]> {
    if (selector === undefined) return [];
    try {
      const registration =
        selector.kind === "registration"
          ? await this.#selectedStoredRegistration(selector.id)
          : await resolveClientRegistration(
              this.#options.db,
              selector.id,
              "slack",
              this.#options.platformApps,
              this.#options.env.TREMA_CREDENTIAL_MASTER_KEY,
            );
      return registration.signingSecret
        ? [{ signingSecret: registration.signingSecret, connectionIds: [] }]
        : [];
    } catch (error) {
      if (
        error instanceof ClientRegistrationNotFoundError ||
        error instanceof NoClientRegistrationError
      ) {
        return [];
      }
      throw error;
    }
  }

  async #selectedStoredRegistration(registrationId: string) {
    const selected = await this.#options.db.clientRegistration.findUnique({
      where: { id: registrationId },
      select: { orgId: true, providerKey: true },
    });
    if (selected === null || selected.providerKey !== "slack") {
      throw new ClientRegistrationNotFoundError();
    }
    return resolveStoredClientRegistration(
      this.#options.db,
      selected.orgId,
      registrationId,
      this.#options.platformApps,
      this.#options.env.TREMA_CREDENTIAL_MASTER_KEY,
    );
  }

  async #signingSecrets(workspaceId: string | undefined): Promise<SlackSigningCandidate[]> {
    const matchingConnections = workspaceId
      ? await this.#options.db.connectorConnection.findMany({
          where: {
            providerKey: "slack",
            revokedAt: null,
            config: { path: ["team.id"], equals: workspaceId },
            owner: { kind: "agent", deactivatedAt: null },
          },
          select: { id: true, orgId: true, clientRegistrationId: true },
        })
      : [];
    const secrets = new Map<string, Set<string>>();
    const candidates = new Map<
      string,
      { orgId: string; registrationId?: string; connectionIds: Set<string> }
    >();
    for (const connection of matchingConnections) {
      const registrationId = connection.clientRegistrationId ?? undefined;
      const key = `${connection.orgId}:${registrationId ?? "preferred"}`;
      const candidate = candidates.get(key) ?? {
        orgId: connection.orgId,
        ...(registrationId === undefined ? {} : { registrationId }),
        connectionIds: new Set<string>(),
      };
      candidate.connectionIds.add(connection.id);
      candidates.set(key, candidate);
    }
    for (const candidate of candidates.values()) {
      try {
        const registration = candidate.registrationId
          ? await resolveStoredClientRegistration(
              this.#options.db,
              candidate.orgId,
              candidate.registrationId,
              this.#options.platformApps,
              this.#options.env.TREMA_CREDENTIAL_MASTER_KEY,
            )
          : await resolveClientRegistration(
              this.#options.db,
              candidate.orgId,
              "slack",
              this.#options.platformApps,
              this.#options.env.TREMA_CREDENTIAL_MASTER_KEY,
            );
        if (registration.signingSecret) {
          const connectionIds = secrets.get(registration.signingSecret) ?? new Set<string>();
          for (const connectionId of candidate.connectionIds) connectionIds.add(connectionId);
          secrets.set(registration.signingSecret, connectionIds);
        }
      } catch (error) {
        if (error instanceof NoClientRegistrationError) continue;
        throw error;
      }
    }
    return [...secrets].map(([signingSecret, connectionIds]) => ({
      signingSecret,
      connectionIds: [...connectionIds],
    }));
  }

  async #process(
    event: ProcessableSurfaceEvent,
    connectionIds: readonly string[],
  ): Promise<"completed" | "blocked"> {
    const startedAt = performance.now();
    try {
      if (event.type === "message") {
        const outcome = await this.#message(event, connectionIds);
        if (outcome === "blocked") return "blocked";
        if (
          event.nativeKind === "app-mention" &&
          (await this.#isOwnedThread(event, connectionIds))
        ) {
          await this.#wakeOwnedThread(event);
        }
      } else {
        await this.#interaction(event, connectionIds);
      }
      log.info("Slack delivery processed", {
        nativeKind: event.type === "message" ? event.nativeKind : event.action.type,
        durationMs: Math.round(performance.now() - startedAt),
      });
      return "completed";
    } catch (error) {
      const durationMs = Math.round(performance.now() - startedAt);
      if (error instanceof SlackRequestRejectedError) {
        if (error.reason === "bot_event") {
          log.debug("Slack bot delivery ignored", { durationMs });
          return "completed";
        }
        log.warn("Slack delivery rejected", { reason: error.reason, durationMs });
        if (error.reason === "location_unbound") {
          await this.#safeNotice(
            event,
            this.#channelBindingNotice(event),
            "channel",
            connectionIds,
            error.context,
          );
        } else if (error.reason === "identity_unlinked") {
          await this.#safeNotice(
            event,
            await this.#identityLinkNotice(event, error.context),
            "private",
            connectionIds,
            error.context,
          );
        } else if (shouldNotify(error.reason)) {
          await this.#safeNotice(
            event,
            SAFE_REJECTION,
            "private",
            connectionIds,
            error.context,
          );
        }
        return "completed";
      }
      if (
        error instanceof IntentMismatchError ||
        error instanceof IntentOptionError ||
        error instanceof IntentStateError ||
        error instanceof IntentTargetError ||
        error instanceof SlackTargetMismatchError
      ) {
        log.warn("Slack interaction rejected", { code: intentErrorCode(error), durationMs });
        await this.#safeNotice(event, SAFE_REJECTION, "private", connectionIds);
        return "completed";
      }
      if (error instanceof SlackRunSchedulingUnavailableError) {
        log.warn("Slack run scheduling unavailable", { durationMs });
        await this.#safeNotice(event, SAFE_UNAVAILABLE, "private", connectionIds);
        return "completed";
      }
      log.error("Slack delivery processing failed", { error, durationMs });
      throw error;
    }
  }

  async #wakeOwnedThread(event: MessageSurfaceEvent): Promise<void> {
    const threadKey = slackSurfaceThreadKey(event);
    const nativeOrder = slackMessageOrder(event.nativeMessageRef);
    if (threadKey === undefined || nativeOrder === undefined) return;
    await this.#options.db.$transaction([
      this.#options.db.slackIngressDelivery.updateMany({
        where: { id: slackSurfaceDeliveryId(event), completedAt: null },
        data: { ownsThread: true },
      }),
      this.#options.db.slackIngressDelivery.updateMany({
        where: {
          completedAt: null,
          awaitingThread: true,
          leaseOwner: null,
          threadKey,
          nativeOrder: { gt: nativeOrder },
        },
        data: { awaitingThread: false, leaseUntil: null },
      }),
    ]);
  }

  async #message(
    event: MessageSurfaceEvent,
    connectionIds: readonly string[],
  ): Promise<"completed" | "blocked"> {
    if (await this.#isMentionShadow(event, connectionIds)) return "completed";
    if (event.nativeKind === "thread-reply") {
      if (!(await this.#isOwnedThread(event, connectionIds))) {
        log.debug("Slack thread reply awaiting an owning delivery");
        return "blocked";
      }
      const ownershipOrder = await this.#replyOwnershipOrder(event);
      if (ownershipOrder === "pending") {
        log.debug("Slack thread reply awaits ownership ordering");
        return "blocked";
      }
      if (ownershipOrder === "predates") {
        log.debug("Slack thread reply predates Trema ownership");
        return "completed";
      }
    }
    const request = await this.#resolve(event, connectionIds);
    const engine = this.#options.runEngineFor?.(request.orgId);
    if (engine === undefined) throw new SlackRunSchedulingUnavailableError();
    const text = stripBotMention(event.text, request.botUserId);
    if (text.length === 0) return "completed";
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
    const started = await startRun({
      services,
      input: {
        intentId: event.intentId,
        trigger: "message",
        surface: "slack",
        locationRef: request.locationRef,
        threadRef: request.logicalThreadRef,
        surfaceThreadRef: event.nativeKind === "direct-message" ? null : event.surfaceRef.threadRef,
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
    if (started.runId === null) throw new SlackRunClaimPendingError();
    return "completed";
  }

  async #resumeParkedReply(
    id: string,
    owner: string,
    event: MessageSurfaceEvent,
    connectionIds: readonly string[],
  ): Promise<boolean> {
    if (!(await this.#isOwnedThread(event, connectionIds))) return false;
    const reclaimed = await this.#options.db.slackIngressDelivery.updateMany({
      where: {
        id,
        completedAt: null,
        awaitingThread: true,
        leaseOwner: null,
      },
      data: {
        awaitingThread: false,
        leaseOwner: owner,
        leaseUntil: new Date(Date.now() + SLACK_INGRESS_LEASE_MS),
      },
    });
    if (reclaimed.count === 0) return false;
    const outcome = await this.#process(event, connectionIds);
    if (outcome === "blocked") {
      const retryAt = new Date(Date.now() + SLACK_THREAD_OWNERSHIP_WAIT_MS);
      await this.#options.db.slackIngressDelivery.updateMany({
        where: { id, completedAt: null, leaseOwner: owner },
        data: { awaitingThread: true, leaseOwner: null, leaseUntil: retryAt },
      });
      this.#scheduleRecovery(retryAt);
      return false;
    }
    await this.#completeDelivery(id, owner);
    return true;
  }

  async #replyOwnershipOrder(
    event: MessageSurfaceEvent,
  ): Promise<"follows" | "pending" | "predates"> {
    const threadKey = slackSurfaceThreadKey(event);
    if (threadKey === undefined) return "follows";
    const opener = await this.#options.db.slackIngressDelivery.findFirst({
      where: {
        threadKey,
        ownsThread: true,
        nativeOrder: { not: null },
      },
      orderBy: { nativeOrder: "asc" },
      select: { nativeOrder: true },
    });
    if (opener?.nativeOrder === undefined || opener.nativeOrder === null) {
      const pendingOpener = await this.#options.db.slackIngressDelivery.findFirst({
        where: { threadKey, opensThread: true, completedAt: null },
        select: { id: true },
      });
      return pendingOpener === null ? "follows" : "pending";
    }
    const nativeOrder = slackMessageOrder(event.nativeMessageRef);
    return nativeOrder !== undefined && nativeOrder > opener.nativeOrder ? "follows" : "predates";
  }

  async #isOwnedThread(
    event: MessageSurfaceEvent,
    connectionIds: readonly string[],
  ): Promise<boolean> {
    const workspaceId = event.surfaceRef.teamRef;
    if (workspaceId === undefined) return false;
    const connections = await this.#options.db.connectorConnection.findMany({
      where: {
        id: { in: [...connectionIds] },
        providerKey: "slack",
        revokedAt: null,
        config: { path: ["team.id"], equals: workspaceId },
        owner: { kind: "agent", deactivatedAt: null },
      },
      select: { orgId: true },
    });
    const orgIds = [...new Set(connections.map((connection) => connection.orgId))];
    if (orgIds.length === 0) return false;
    const session = await this.#options.db.contextSession.findFirst({
      where: {
        orgId: { in: orgIds },
        surface: "slack",
        locationRef: event.surfaceRef.locationRef,
        threadRef: event.surfaceRef.threadRef,
      },
      select: { id: true },
    });
    return session !== null;
  }

  async #isMentionShadow(
    event: MessageSurfaceEvent,
    connectionIds: readonly string[],
  ): Promise<boolean> {
    if (event.nativeKind !== "thread-reply" || !event.text.includes("<@")) return false;
    const workspaceId = event.surfaceRef.teamRef;
    if (workspaceId === undefined) return false;
    const connections = await this.#options.db.connectorConnection.findMany({
      where: {
        id: { in: [...connectionIds] },
        providerKey: "slack",
        revokedAt: null,
        config: { path: ["team.id"], equals: workspaceId },
        owner: { kind: "agent", deactivatedAt: null },
      },
      select: { config: true },
    });
    return connections.some((connection) => {
      const config = connection.config;
      if (typeof config !== "object" || config === null || Array.isArray(config)) return false;
      const botUserId = (config as Record<string, unknown>).bot_user_id;
      return typeof botUserId === "string" && event.text.includes(`<@${botUserId}>`);
    });
  }

  async #interaction(
    event: InteractionSurfaceEvent,
    connectionIds: readonly string[],
  ): Promise<void> {
    if (event.action.type === "native" || event.surfaceRef === undefined) return;
    const request = await this.#resolve(event, connectionIds);
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
        logicalThreadRef: request.logicalThreadRef,
        locationRef: request.locationRef,
        threadRef: event.surfaceRef.channelRef.startsWith("D") ? null : event.surfaceRef.threadRef,
      });
      const submitted = await submitTargetIntent({
        services,
        input: { intentId: event.intentId, by, intent: event.action },
      });
      if (submitted.runId === null) throw new SlackRunClaimPendingError();
      return;
    }
    if (request.runId === null || request.runId !== event.action.runId) {
      throw new SlackTargetMismatchError();
    }
    const submitted = await submitTargetIntent({
      services,
      input: { intentId: event.intentId, by, intent: event.action },
    });
    if (submitted.runId === null) throw new SlackRunClaimPendingError();
  }

  #resolve(event: MessageSurfaceEvent | InteractionSurfaceEvent, connectionIds: readonly string[]) {
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
      connectionIds,
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
    visibility: "private" | "channel" = "private",
    connectionIds?: readonly string[],
    resolved?: SlackRequestRejectionContext,
  ): Promise<void> {
    if (event.surfaceRef === undefined || event.surfaceRef.teamRef === undefined) return;
    await this.#notify({
      workspaceId: event.surfaceRef.teamRef,
      channelId: event.surfaceRef.channelRef,
      threadTs: event.surfaceRef.threadRef,
      userId: event.authorRef,
      directMessage: event.surfaceRef.channelRef.startsWith("D"),
      visibility,
      text,
      ...(connectionIds === undefined ? {} : { connectionIds }),
      ...(resolved === undefined
        ? {}
        : { orgId: resolved.orgId, connectionId: resolved.connectionId }),
    }).catch(() => {
      // Provider failures can retain request objects containing credentials.
      // Report only that the safe response failed, never the error object.
      log.warn("Slack rejection response failed");
    });
  }

  #channelBindingNotice(event: MessageSurfaceEvent | InteractionSurfaceEvent): string {
    const surfaceRef = event.surfaceRef;
    if (surfaceRef === undefined || surfaceRef.teamRef === undefined) return SAFE_REJECTION;
    const url = new URL("/settings/messaging", this.#options.env.TREMA_WEB_ORIGINS[0]);
    url.searchParams.set("setup", "slack-channel");
    url.searchParams.set("workspaceId", surfaceRef.teamRef);
    url.searchParams.set("channelId", surfaceRef.channelRef);
    return `This channel isn't connected to a Trema scope. <${url.toString()}|Configure channel>.`;
  }

  async #identityLinkNotice(
    event: MessageSurfaceEvent | InteractionSurfaceEvent,
    resolved?: SlackRequestRejectionContext,
  ): Promise<string> {
    const surfaceRef = event.surfaceRef;
    if (surfaceRef === undefined || surfaceRef.teamRef === undefined) return SAFE_REJECTION;
    if (resolved === undefined) return SAFE_REJECTION;
    try {
      const minted = await mintSlackIdentityLinkChallenge(this.#options.db, this.#options.env, {
        orgId: resolved.orgId,
        workspaceId: surfaceRef.teamRef,
        userId: event.authorRef,
      });
      return `This Slack account isn't linked to Trema. <${minted.link}|Link your Trema account>, then retry your message.`;
    } catch (error) {
      log.warn("Slack identity link challenge mint failed", {
        orgId: resolved.orgId,
        workspaceId: surfaceRef.teamRef,
        userId: event.authorRef,
        error,
      });
      return SAFE_REJECTION;
    }
  }

  async #sendNotice(input: Parameters<SlackIngressNotice>[0]): Promise<void> {
    const connection =
      input.orgId !== undefined && input.connectionId !== undefined
        ? { id: input.connectionId, orgId: input.orgId }
        : await this.#options.db.connectorConnection.findFirst({
            where: {
              ...(input.connectionIds === undefined ? {} : { id: { in: [...input.connectionIds] } }),
              providerKey: SLACK_PROVIDER_KEY,
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
    if (input.directMessage || input.visibility === "channel") {
      await driver.callNative("chat.postMessage", {
        channel: input.channelId,
        thread_ts: input.threadTs,
        text: input.text,
        unfurl_links: false,
        unfurl_media: false,
      });
      return;
    }
    await driver.callNative("chat.postEphemeral", {
      channel: input.channelId,
      thread_ts: input.threadTs,
      user: input.userId,
      text: input.text,
      unfurl_links: false,
      unfurl_media: false,
    });
  }
}

export class SlackIngressConfigurationError extends Error {
  constructor() {
    super("No Slack signing secret is configured for this delivery");
    this.name = "SlackIngressConfigurationError";
  }
}

export class SlackIngressBodyTooLargeError extends Error {
  constructor() {
    super("Slack webhook body exceeds the size limit");
    this.name = "SlackIngressBodyTooLargeError";
  }
}

class SlackRunSchedulingUnavailableError extends Error {}

class SlackRunClaimPendingError extends Error {}

class SlackTargetMismatchError extends Error {
  readonly code = "target_mismatch";
}

function shouldNotify(reason: SlackRequestRejectedError["reason"]): boolean {
  return (
    reason === "identity_unlinked" ||
    reason === "identity_deactivated" ||
    reason === "location_unbound" ||
    reason === "personal_scopes_disabled" ||
    reason === "connector_mismatch"
  );
}

function intentErrorCode(error: Error): string {
  return "code" in error && typeof error.code === "string" ? error.code : error.name;
}

function ingressRetryDelay(attempt: number): number {
  return Math.min(60_000, SLACK_INGRESS_RETRY_MS * 2 ** Math.min(Math.max(attempt - 1, 0), 6));
}

async function readSlackWebhookBody(request: Request): Promise<string> {
  const contentLength = request.headers.get("content-length");
  if (
    contentLength !== null &&
    /^\d+$/u.test(contentLength) &&
    Number(contentLength) > SLACK_WEBHOOK_MAX_BODY_BYTES
  ) {
    await request.body?.cancel();
    throw new SlackIngressBodyTooLargeError();
  }
  if (request.body === null) return "";

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  let body = "";
  let bytes = 0;
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > SLACK_WEBHOOK_MAX_BODY_BYTES) {
        await reader.cancel();
        throw new SlackIngressBodyTooLargeError();
      }
      body += decoder.decode(chunk.value, { stream: true });
    }
    return body + decoder.decode();
  } finally {
    reader.releaseLock();
  }
}

function slackIngressThreadKey(payload: SlackIngressPayload): string | undefined {
  return payload.kind === "surface" && payload.event.type === "message"
    ? slackSurfaceThreadKey(payload.event)
    : undefined;
}

function slackIngressNativeOrder(payload: SlackIngressPayload): bigint | undefined {
  return payload.kind === "surface" && payload.event.type === "message"
    ? slackMessageOrder(payload.event.nativeMessageRef)
    : undefined;
}

function slackMessageOrder(nativeMessageRef: string): bigint | undefined {
  const match = /^(\d{1,12})(?:\.(\d{1,6}))?$/u.exec(nativeMessageRef);
  if (match?.[1] === undefined) return undefined;
  try {
    return BigInt(match[1]) * 1_000_000n + BigInt((match[2] ?? "").padEnd(6, "0"));
  } catch {
    return undefined;
  }
}

function slackIngressOpensThread(payload: SlackIngressPayload): boolean {
  return (
    payload.kind === "surface" &&
    payload.event.type === "message" &&
    payload.event.nativeKind === "app-mention"
  );
}

function slackSurfaceThreadKey(event: MessageSurfaceEvent): string | undefined {
  const threadRef = event.surfaceRef.threadRef;
  if (threadRef === undefined || event.nativeKind === "direct-message") return undefined;
  return createHash("sha256").update(`${event.surfaceRef.locationRef}\0${threadRef}`).digest("hex");
}

function stripBotMention(text: string, botUserId: string | null): string {
  if (botUserId === null) return text.trim();
  return text.replace(new RegExp(`<@${botUserId}>`, "gu"), "").trim();
}

function slackRegistrationSelector(requestUrl: string): SlackSigningSelector | undefined {
  const parameters = new URL(requestUrl).searchParams;
  const registrationId = parameters.get("registration_id");
  if (registrationId !== null && isUuid(registrationId)) {
    return { kind: "registration", id: registrationId };
  }
  const orgId = parameters.get("org_id");
  return orgId !== null && isUuid(orgId) ? { kind: "org", id: orgId } : undefined;
}

function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu.test(value);
}

function slackEnvelopeHint(
  body: string,
  contentType: string | null,
): { urlVerification: boolean; workspaceId?: string } {
  let payload: unknown;
  try {
    payload = contentType?.includes("application/x-www-form-urlencoded")
      ? JSON.parse(new URLSearchParams(body).get("payload") ?? "null")
      : JSON.parse(body);
  } catch {
    return { urlVerification: false };
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    return { urlVerification: false };
  }
  const record = payload as Record<string, unknown>;
  const direct = record.team_id;
  const team = record.team;
  const nested =
    typeof team === "object" && team !== null && !Array.isArray(team)
      ? (team as Record<string, unknown>).id
      : undefined;
  const candidate = typeof direct === "string" ? direct : nested;
  const workspaceId = slackId(candidate);
  return {
    urlVerification: record.type === "url_verification",
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
}

function slackLifecycleEvent(payload: unknown): SlackLifecycleEvent | undefined {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return undefined;
  const envelope = payload as Record<string, unknown>;
  if (envelope.type !== "event_callback") return undefined;
  const workspaceId = slackId(envelope.team_id);
  const appId = slackId(envelope.api_app_id);
  const native =
    typeof envelope.event === "object" && envelope.event !== null && !Array.isArray(envelope.event)
      ? (envelope.event as Record<string, unknown>)
      : undefined;
  if (workspaceId === undefined || appId === undefined || native === undefined) return undefined;
  if (native.type === "app_uninstalled") return { type: "app_uninstalled", workspaceId, appId };
  if (native.type !== "tokens_revoked") return undefined;
  const tokens =
    typeof native.tokens === "object" && native.tokens !== null && !Array.isArray(native.tokens)
      ? (native.tokens as Record<string, unknown>)
      : {};
  return {
    type: "tokens_revoked",
    workspaceId,
    appId,
    botUserIds: slackIds(tokens.bot),
    oauthUserIds: slackIds(tokens.oauth),
  };
}

function slackLifecycleDeliveryId(payload: unknown): string {
  const envelope =
    typeof payload === "object" && payload !== null && !Array.isArray(payload)
      ? (payload as Record<string, unknown>)
      : {};
  const eventId = envelope.event_id;
  if (typeof eventId === "string" && eventId.length > 0) return `slack:lifecycle:${eventId}`;
  const digest = createHash("sha256").update(JSON.stringify(payload)).digest("hex");
  return `slack:lifecycle:${digest}`;
}

function slackSurfaceDeliveryId(event: ProcessableSurfaceEvent): string {
  const workspaceRef = event.surfaceRef?.teamRef ?? event.surfaceRef?.locationRef ?? "unscoped";
  const channelRef = event.surfaceRef?.channelRef ?? "unscoped";
  return `slack:delivery:${workspaceRef}:${channelRef}:${event.intentId}`;
}

function slackId(value: unknown): string | undefined {
  return typeof value === "string" && /^[A-Z][A-Z0-9]{1,31}$/.test(value) ? value : undefined;
}

function slackIds(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((candidate) => {
        const id = slackId(candidate);
        return id === undefined ? [] : [id];
      })
    : [];
}

async function requireSlackElicitationTarget(
  db: Database,
  input: {
    orgId: string;
    elicitationId: string;
    logicalThreadRef: string;
    locationRef: string;
    threadRef: string | null;
  },
): Promise<void> {
  const elicitation = await db.runElicitation.findUnique({
    where: { orgId_id: { orgId: input.orgId, id: input.elicitationId } },
    select: {
      run: {
        select: {
          threadRef: true,
          session: { select: { surface: true, locationRef: true, threadRef: true } },
        },
      },
    },
  });
  const session = elicitation?.run.session;
  if (
    elicitation?.run.threadRef !== input.logicalThreadRef ||
    session?.surface !== "slack" ||
    session.locationRef !== input.locationRef ||
    session.threadRef !== input.threadRef
  ) {
    throw new SlackTargetMismatchError();
  }
}
