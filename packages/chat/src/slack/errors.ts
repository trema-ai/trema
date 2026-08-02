import { SlackApiError } from "@chat-adapter/slack/api";
import { SurfaceDriverError, type SurfaceErrorCode } from "@trema/surfaces";

const REVOKED_ERRORS = new Set(["account_inactive", "app_uninstalled", "token_revoked"]);
const UNAUTHORIZED_ERRORS = new Set(["invalid_auth", "not_authed", "token_expired"]);
const MESSAGE_NOT_FOUND_ERRORS = new Set([
  "message_not_found",
  "message_not_in_streaming_state",
  "thread_not_found",
]);
const DESTINATION_NOT_FOUND_ERRORS = new Set([
  "channel_not_found",
  "is_archived",
  "team_not_found",
]);
const INVALID_REQUEST_ERRORS = new Set([
  "invalid_arg_name",
  "invalid_arguments",
  "invalid_array_arg",
  "invalid_blocks",
  "invalid_blocks_format",
  "invalid_chunks",
  "invalid_metadata_format",
  "invalid_metadata_schema",
  "no_text",
]);
const UNAVAILABLE_ERRORS = new Set([
  "fatal_error",
  "internal_error",
  "org_login_required",
  "request_timeout",
  "service_unavailable",
  "team_added_to_org",
]);

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

function classifyPlatformError(code: string | undefined): {
  code: SurfaceErrorCode;
  retryable: boolean;
} {
  if (code === "ratelimited" || code === "rate_limited") {
    return { code: "rate_limited", retryable: true };
  }
  if (code !== undefined && REVOKED_ERRORS.has(code)) {
    return { code: "revoked", retryable: false };
  }
  if (code !== undefined && UNAUTHORIZED_ERRORS.has(code)) {
    return { code: "unauthorized", retryable: false };
  }
  if (code !== undefined && MESSAGE_NOT_FOUND_ERRORS.has(code)) {
    return { code: "message_not_found", retryable: false };
  }
  if (code !== undefined && DESTINATION_NOT_FOUND_ERRORS.has(code)) {
    return { code: "destination_not_found", retryable: false };
  }
  if (code !== undefined && INVALID_REQUEST_ERRORS.has(code)) {
    return { code: "invalid_request", retryable: false };
  }
  if (code !== undefined && UNAVAILABLE_ERRORS.has(code)) {
    return { code: "unavailable", retryable: true };
  }
  return { code: "permanent", retryable: false };
}

export function mapSlackError(
  error: unknown,
  method: string,
  retryAfterMs?: number,
): SurfaceDriverError {
  if (error instanceof SurfaceDriverError) return error;

  if (error instanceof SlackApiError) {
    const platformCode = error.response?.error;
    const classification =
      error.status === 429
        ? { code: "rate_limited" as const, retryable: true }
        : error.status !== undefined && error.status >= 500
          ? { code: "unavailable" as const, retryable: true }
          : classifyPlatformError(platformCode);
    return new SurfaceDriverError(
      classification.code,
      slackErrorMessage(classification.code, method),
      {
        cause: error,
        retryable: classification.retryable,
        ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
      },
    );
  }

  const code = errorCode(error);
  if (code === "slack_webapi_rate_limited_error") {
    const delay = retryAfter(error);
    return new SurfaceDriverError("rate_limited", `Slack rate-limited ${method}`, {
      cause: error,
      retryable: true,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    });
  }
  if (code === "slack_webapi_platform_error") {
    const classification = classifyPlatformError(platformErrorCode(error));
    return new SurfaceDriverError(
      classification.code,
      slackErrorMessage(classification.code, method),
      { cause: error, retryable: classification.retryable },
    );
  }

  return new SurfaceDriverError("unavailable", `Slack ${method} failed temporarily`, {
    cause: error,
    retryable: true,
  });
}

function slackErrorMessage(code: SurfaceErrorCode, method: string): string {
  switch (code) {
    case "rate_limited":
      return `Slack rate-limited ${method}`;
    case "unavailable":
      return `Slack ${method} failed temporarily`;
    case "unauthorized":
      return `Slack rejected the credential for ${method}`;
    case "revoked":
      return `Slack installation was revoked for ${method}`;
    case "message_not_found":
      return `Slack could not find the message for ${method}`;
    case "destination_not_found":
      return `Slack could not find the destination for ${method}`;
    case "invalid_request":
      return `Slack rejected the ${method} payload`;
    default:
      return `Slack rejected ${method}`;
  }
}
