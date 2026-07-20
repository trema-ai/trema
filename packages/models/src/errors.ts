import { APICallError } from "ai";

export interface ModelErrorData {
  message: string;
  retryable: boolean;
  retryAfterMs?: number;
}

function retryAfterMs(headers: Record<string, string> | undefined): number | undefined {
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (value === undefined) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1_000);
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : Math.max(0, date - Date.now());
}

export function modelErrorData(error: unknown): ModelErrorData {
  if (APICallError.isInstance(error)) {
    const delay = retryAfterMs(error.responseHeaders);
    return {
      message: error.message,
      retryable: error.statusCode === undefined
        ? error.isRetryable
        : error.statusCode === 429 || error.statusCode >= 500,
      ...(delay === undefined ? {} : { retryAfterMs: delay }),
    };
  }
  return {
    message: error instanceof Error ? error.message : String(error),
    retryable: false,
  };
}

export function isAbortFailure(error: unknown, signal: AbortSignal): boolean {
  return signal.aborted || (error instanceof Error && error.name === "AbortError");
}
