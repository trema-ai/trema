import { retryDecision, SurfaceDriverError } from "@trema/surfaces";
import { describe, expect, it } from "vitest";

describe("retryDecision", () => {
  it("honors a platform retry-after and caps exponential retries", () => {
    const limited = new SurfaceDriverError("rate_limited", "slow down", {
      retryable: true,
      retryAfterMs: 12_000,
    });
    expect(retryDecision(limited, 2)).toEqual({ disposition: "retry", delayMs: 12_000 });
    expect(retryDecision(new Error("network"), 20)).toEqual({
      disposition: "retry",
      delayMs: 300_000,
    });
    const longLimit = new SurfaceDriverError("rate_limited", "try tomorrow", {
      retryable: true,
      retryAfterMs: 86_400_000,
    });
    expect(retryDecision(longLimit, 20)).toEqual({
      disposition: "retry",
      delayMs: 86_400_000,
    });
  });

  it("does not retry a terminal driver classification", () => {
    const revoked = new SurfaceDriverError("revoked", "installation revoked", {
      retryable: false,
    });
    expect(retryDecision(revoked, 0)).toEqual({ disposition: "terminal" });
  });
});
