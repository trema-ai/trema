import type { RetryDecision } from "#surfaces/types.js";
import { SurfaceDriverError } from "#surfaces/types.js";

const DEFAULT_BASE_DELAY_MS = 1_000;
const DEFAULT_MAX_DELAY_MS = 5 * 60_000;

/** Deterministic retry policy. Drivers classify errors; the core owns timing. */
export function retryDecision(
  error: unknown,
  attempt: number,
  options: { baseDelayMs?: number; maxDelayMs?: number } = {},
): RetryDecision {
  if (error instanceof SurfaceDriverError && !error.retryable) {
    return { disposition: "terminal" };
  }

  const base = options.baseDelayMs ?? DEFAULT_BASE_DELAY_MS;
  const maximum = options.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
  const requested = error instanceof SurfaceDriverError ? error.retryAfterMs : undefined;
  const exponential = base * 2 ** Math.max(0, attempt);
  return { disposition: "retry", delayMs: Math.min(requested ?? exponential, maximum) };
}
