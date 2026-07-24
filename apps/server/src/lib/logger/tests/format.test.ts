import { describe, expect, it } from "vitest";

import { formatRecord, type LogRecord } from "#/lib/logger/format.js";

function record(overrides: Partial<LogRecord> = {}): LogRecord {
  return {
    time: "2026-07-24T10:00:00.000Z",
    level: "info",
    message: "Server listening",
    details: {},
    ...overrides,
  };
}

describe("formatRecord", () => {
  describe("logfmt", () => {
    const logfmt = (overrides: Partial<LogRecord> = {}) =>
      formatRecord("logfmt", record(overrides));

    it("writes the envelope first", () => {
      expect(logfmt()).toBe('time=2026-07-24T10:00:00.000Z level=info msg="Server listening"');
    });

    it("quotes only values that need it", () => {
      expect(
        logfmt({ message: "ready", details: { url: "http://127.0.0.1:3000", count: 2 } }),
      ).toBe(
        "time=2026-07-24T10:00:00.000Z level=info msg=ready url=http://127.0.0.1:3000 count=2",
      );
    });

    it("quotes empty, spaced, and escaped values", () => {
      expect(
        logfmt({ message: "x", details: { empty: "", spaced: "a b", quoted: 'say "hi"' } }),
      ).toBe(
        'time=2026-07-24T10:00:00.000Z level=info msg=x empty="" spaced="a b" quoted="say \\"hi\\""',
      );
    });

    it("flattens nested details onto dotted keys", () => {
      const line = logfmt({ details: { run: { id: "run_1", turn: 3 }, tags: ["a", "b"] } });

      expect(line).toContain("run.id=run_1");
      expect(line).toContain("run.turn=3");
      expect(line).toContain('tags="[\\"a\\",\\"b\\"]"');
    });

    it("renders booleans, null, dates, and bigints", () => {
      const line = logfmt({
        details: {
          ok: false,
          missing: null,
          at: new Date("2026-07-24T10:00:00.000Z"),
          big: 9_007_199_254_740_993n,
        },
      });

      expect(line).toContain("ok=false");
      expect(line).toContain("missing=null");
      expect(line).toContain("at=2026-07-24T10:00:00.000Z");
      expect(line).toContain("big=9007199254740993");
    });

    it("drops undefined details and details that shadow the envelope", () => {
      const line = logfmt({ details: { skipped: undefined, level: "debug", kept: "yes" } });

      expect(line).toBe('time=2026-07-24T10:00:00.000Z level=info msg="Server listening" kept=yes');
    });

    it("replaces separators in keys", () => {
      expect(logfmt({ details: { "odd key=name": "value" } })).toContain("odd_key_name=value");
    });
  });

  describe("json", () => {
    const json = (overrides: Partial<LogRecord> = {}) =>
      JSON.parse(formatRecord("json", record(overrides))) as Record<string, unknown>;

    it("writes one object per line", () => {
      expect(json({ details: { port: 3000 } })).toEqual({
        time: "2026-07-24T10:00:00.000Z",
        level: "info",
        msg: "Server listening",
        port: 3000,
      });
    });

    it("keeps details nested", () => {
      expect(json({ details: { run: { id: "run_1", turn: 3 } } }).run).toEqual({
        id: "run_1",
        turn: 3,
      });
    });

    it("drops details that shadow the envelope", () => {
      expect(json({ details: { msg: "hijacked", time: "then" } })).toEqual({
        time: "2026-07-24T10:00:00.000Z",
        level: "info",
        msg: "Server listening",
      });
    });
  });

  describe("errors", () => {
    class TokenError extends Error {
      readonly code = "token_exchange_failed";

      constructor() {
        super("Token exchange failed");
        this.name = "TokenError";
      }
    }

    it("expands an error into name, message, stack, and own fields", () => {
      const parsed = JSON.parse(
        formatRecord("json", record({ level: "error", details: { error: new TokenError() } })),
      ) as { error: Record<string, unknown> };

      expect(parsed.error).toMatchObject({
        name: "TokenError",
        message: "Token exchange failed",
        code: "token_exchange_failed",
      });
      expect(parsed.error.stack).toContain("TokenError");
    });

    it("keeps the cause chain", () => {
      const error = new Error("outer", { cause: new Error("inner") });
      const parsed = JSON.parse(formatRecord("json", record({ details: { error } }))) as {
        error: { cause: { message: string } };
      };

      expect(parsed.error.cause.message).toBe("inner");
    });

    it("flattens an error across logfmt keys", () => {
      const line = formatRecord("logfmt", record({ details: { error: new TokenError() } }));

      expect(line).toContain("error.name=TokenError");
      expect(line).toContain('error.message="Token exchange failed"');
      expect(line).toContain("error.code=token_exchange_failed");
    });
  });

  it("replaces cycles instead of throwing", () => {
    const details: Record<string, unknown> = { name: "loop" };
    details.self = details;

    expect(JSON.parse(formatRecord("json", record({ details })))).toMatchObject({
      name: "loop",
      self: { name: "loop", self: "[circular]" },
    });
  });

  it("renders non-finite numbers as text", () => {
    expect(formatRecord("logfmt", record({ details: { ratio: Number.NaN } }))).toContain(
      "ratio=NaN",
    );
  });
});
