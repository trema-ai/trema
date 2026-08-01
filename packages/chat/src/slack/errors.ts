import { SlackApiError } from "@chat-adapter/slack/api";
import { SurfaceDriverError } from "#chat/errors.js";

const AUTHENTICATION_ERRORS = new Set([
  "account_inactive",
  "invalid_auth",
  "not_authed",
  "token_expired",
  "token_revoked",
]);

const NOT_FOUND_ERRORS = new Set(["channel_not_found", "message_not_found", "thread_not_found"]);

function errorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) return undefined;
  return typeof error.code === "string" ? error.code : undefined;
}

function retryAfter(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null || !("retryAfter" in error)) return undefined;
  return typeof error.retryAfter === "number" ? error.retryAfter * 1_000 : undefined;
}

function platformErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("data" in error)) return undefined;
  const { data } = error;
  if (typeof data !== "object" || data === null || !("error" in data)) return undefined;
  return typeof data.error === "string" ? data.error : undefined;
}

export function mapSlackError(
  error: unknown,
  method: string,
  retryAfterMs?: number,
): SurfaceDriverError {
  if (error instanceof SurfaceDriverError) return error;

  if (error instanceof SlackApiError) {
    const platformError = error.response?.error;
    if (error.status === 429 || platformError === "ratelimited") {
      return new SurfaceDriverError(`Slack rate-limited ${method}`, {
        category: "rate-limited",
        cause: error,
        method,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        retryable: true,
      });
    }
    if (error.status !== undefined && error.status >= 500) {
      return new SurfaceDriverError(`Slack ${method} failed temporarily`, {
        category: "transient",
        cause: error,
        method,
        retryable: true,
      });
    }
    if (typeof platformError === "string" && AUTHENTICATION_ERRORS.has(platformError)) {
      return new SurfaceDriverError(`Slack rejected the credential for ${method}`, {
        category: "authentication",
        cause: error,
        method,
        retryable: false,
      });
    }
    if (typeof platformError === "string" && NOT_FOUND_ERRORS.has(platformError)) {
      return new SurfaceDriverError(`Slack could not find the target for ${method}`, {
        category: "not-found",
        cause: error,
        method,
        retryable: false,
      });
    }
    return new SurfaceDriverError(`Slack rejected ${method}`, {
      category: "permanent",
      cause: error,
      method,
      retryable: false,
    });
  }

  const code = errorCode(error);
  if (code === "slack_webapi_rate_limited_error") {
    const retryAfterMs = retryAfter(error);
    return new SurfaceDriverError(`Slack rate-limited ${method}`, {
      category: "rate-limited",
      cause: error,
      method,
      ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      retryable: true,
    });
  }
  if (code === "slack_webapi_platform_error") {
    const platformError = platformErrorCode(error);
    if (platformError !== undefined && AUTHENTICATION_ERRORS.has(platformError)) {
      return new SurfaceDriverError(`Slack rejected the credential for ${method}`, {
        category: "authentication",
        cause: error,
        method,
        retryable: false,
      });
    }
    if (platformError !== undefined && NOT_FOUND_ERRORS.has(platformError)) {
      return new SurfaceDriverError(`Slack could not find the target for ${method}`, {
        category: "not-found",
        cause: error,
        method,
        retryable: false,
      });
    }
    return new SurfaceDriverError(`Slack rejected ${method}`, {
      category: "permanent",
      cause: error,
      method,
      retryable: false,
    });
  }

  return new SurfaceDriverError(`Slack ${method} failed temporarily`, {
    category: "transient",
    cause: error,
    method,
    retryable: true,
  });
}
