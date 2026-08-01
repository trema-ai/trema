import { parseSlackInputResponse } from "@chat-adapter/slack/blocks";
import {
  readSlackWebhook,
  SlackWebhookParseError,
  SlackWebhookVerificationError,
} from "@chat-adapter/slack/webhook";
import type {
  DeliveryRetry,
  InteractionSurfaceEvent,
  SurfaceEvent,
  SurfaceIngressDriver,
  SurfaceRef,
} from "#chat/contracts.js";
import { SurfaceDriverError } from "#chat/errors.js";
import type { SlackDriverOptions } from "#chat/slack/contracts.js";

export class SlackIngressDriver implements SurfaceIngressDriver {
  readonly #options: Pick<SlackDriverOptions, "now" | "signingSecret">;

  constructor(options: Pick<SlackDriverOptions, "now" | "signingSecret">) {
    this.#options = options;
  }

  async read(request: Request): Promise<SurfaceEvent> {
    try {
      const payload = await readSlackWebhook(request, {
        signingSecret: this.#options.signingSecret,
        ...(this.#options.now === undefined ? {} : { now: this.#options.now }),
      });
      const retry = toRetry(payload.retry);

      if (payload.kind === "url_verification") {
        return { type: "challenge", surface: "slack", challenge: payload.challenge, ...retry };
      }
      if (payload.kind === "app_mention" || payload.kind === "direct_message") {
        const authorRef = payload.userId;
        if (authorRef === undefined || authorRef.length === 0) {
          return unsupported("message-without-author", payload.raw, retry);
        }
        return {
          type: "message",
          surface: "slack",
          intentId: `slack:event:${payload.eventId ?? `${payload.channelId}:${payload.ts}`}`,
          surfaceRef: toSurfaceRef(payload.continuation),
          authorRef,
          text: payload.text,
          at: slackTimestamp(payload.eventTime, payload.ts),
          nativeKind: payload.kind === "app_mention" ? "app-mention" : "direct-message",
          ...retry,
        };
      }
      if (payload.kind === "block_actions") {
        const action = payload.actions[0];
        if (action === undefined) return unsupported("block_actions:empty", payload.raw, retry);
        const resolution = parseSlackInputResponse(action);
        const event: InteractionSurfaceEvent = {
          type: "interaction",
          surface: "slack",
          intentId: `slack:interaction:${payload.triggerId ?? `${payload.userId}:${payload.messageTs ?? "unknown"}:${action.actionId}`}`,
          authorRef: payload.userId,
          action:
            resolution?.optionId === undefined
              ? {
                  type: "native",
                  actionId: action.actionId,
                  ...(action.value === undefined ? {} : { value: action.value }),
                }
              : {
                  type: "resolve",
                  elicitationId: resolution.requestId,
                  optionId: resolution.optionId,
                },
          ...(payload.continuation === undefined
            ? {}
            : { surfaceRef: toSurfaceRef(payload.continuation) }),
          ...retry,
        };
        return event;
      }
      return unsupported(
        payload.kind === "unsupported" ? payload.type : payload.kind,
        payload.raw,
        retry,
      );
    } catch (error) {
      if (error instanceof SlackWebhookVerificationError) {
        throw new SurfaceDriverError("Slack webhook verification failed", {
          category: "invalid-request",
          cause: error,
          method: "webhook.verify",
          retryable: false,
        });
      }
      if (error instanceof SlackWebhookParseError) {
        throw new SurfaceDriverError("Slack webhook parsing failed", {
          category: "invalid-request",
          cause: error,
          method: "webhook.parse",
          retryable: false,
        });
      }
      throw error;
    }
  }
}

function toSurfaceRef(continuation: {
  channelId: string;
  enterpriseId?: string;
  teamId?: string;
  threadTs: string;
}): SurfaceRef {
  const teamRef = continuation.teamId ?? continuation.enterpriseId;
  const locationRef = teamRef ? `${teamRef}:${continuation.channelId}` : continuation.channelId;
  return {
    surface: "slack",
    locationRef,
    channelRef: continuation.channelId,
    threadRef: continuation.threadTs,
    ...(teamRef === undefined ? {} : { teamRef }),
  };
}

function slackTimestamp(eventTime: number | undefined, ts: string): string {
  const seconds = eventTime ?? Number(ts.split(".")[0]);
  return Number.isFinite(seconds)
    ? new Date(seconds * 1_000).toISOString()
    : new Date(0).toISOString();
}

function toRetry(retry: { num: number; reason?: string } | undefined): { retry?: DeliveryRetry } {
  if (retry === undefined) return {};
  return {
    retry: {
      attempt: retry.num,
      ...(retry.reason === undefined ? {} : { reason: retry.reason }),
    },
  };
}

function unsupported(
  nativeType: string,
  nativePayload: unknown,
  retry: { retry?: DeliveryRetry },
): SurfaceEvent {
  return { type: "unsupported", surface: "slack", nativeType, nativePayload, ...retry };
}
