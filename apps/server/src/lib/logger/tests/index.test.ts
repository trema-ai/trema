import { afterEach, describe, expect, it } from "vitest";

import {
  bindLogger,
  configureLogger,
  createLogger,
  createLoggerFromEnv,
  type LoggerOptions,
  log,
  withLogger,
} from "#server/lib/logger/index.js";

function collecting(options: Omit<LoggerOptions, "write" | "now"> = {}) {
  const lines: string[] = [];
  const logger = createLogger({
    ...options,
    write: (line) => lines.push(line),
    now: () => new Date("2026-07-24T10:00:00.000Z"),
  });
  return { logger, lines };
}

describe("createLogger", () => {
  it("takes the message first and details second", () => {
    const { logger, lines } = collecting();

    logger.info("Server listening", { port: 3000 });

    expect(lines).toEqual([
      'time=2026-07-24T10:00:00.000Z level=info msg="Server listening" port=3000',
    ]);
  });

  it("logs without details", () => {
    const { logger, lines } = collecting();

    logger.warn("Migrations pending");

    expect(lines).toEqual(['time=2026-07-24T10:00:00.000Z level=warn msg="Migrations pending"']);
  });

  it("writes json when asked", () => {
    const { logger, lines } = collecting({ format: "json" });

    logger.error("Server failed", { code: "EADDRINUSE" });

    expect(JSON.parse(lines[0] ?? "")).toEqual({
      time: "2026-07-24T10:00:00.000Z",
      level: "error",
      msg: "Server failed",
      code: "EADDRINUSE",
    });
  });

  it("drops records below the level", () => {
    const { logger, lines } = collecting({ level: "warn" });

    logger.debug("noise");
    logger.info("noise");
    logger.warn("kept");
    logger.error("kept");

    expect(lines).toHaveLength(2);
  });

  it("emits debug records when the level allows them", () => {
    const { logger, lines } = collecting({ level: "debug" });

    logger.debug("Query issued", { table: "org" });

    expect(lines[0]).toContain("level=debug");
  });

  it("writes nothing when silent", () => {
    const { logger, lines } = collecting({ level: "silent" });

    logger.error("Server failed");

    expect(lines).toEqual([]);
  });

  it("repeats bound details on every child line", () => {
    const { logger, lines } = collecting({ details: { service: "server" } });

    const child = logger.child({ runId: "run_1" });
    child.info("Turn committed", { turn: 2 });
    child.child({ sessionId: "sess_1" }).info("Tool called");

    expect(lines[0]).toBe(
      'time=2026-07-24T10:00:00.000Z level=info msg="Turn committed" service=server runId=run_1 turn=2',
    );
    expect(lines[1]).toContain("service=server runId=run_1 sessionId=sess_1");
  });

  it("lets a call override a bound detail without mutating the parent", () => {
    const { logger, lines } = collecting({ details: { scope: "root" } });

    const child = logger.child({ scope: "child" });
    child.info("scoped");
    logger.info("root");

    expect(lines[0]).toContain("scope=child");
    expect(lines[1]).toContain("scope=root");
  });
});

describe("createLoggerFromEnv", () => {
  it("takes the format and level from the environment", () => {
    const lines: string[] = [];
    const logger = createLoggerFromEnv(
      { TREMA_LOG_FORMAT: "json", TREMA_LOG_LEVEL: "warn" },
      { write: (line) => lines.push(line), now: () => new Date("2026-07-24T10:00:00.000Z") },
    );

    logger.info("dropped");
    logger.warn("Bootstrap token generated", { bootstrapToken: "token" });

    expect(lines.map((line) => JSON.parse(line))).toEqual([
      {
        time: "2026-07-24T10:00:00.000Z",
        level: "warn",
        msg: "Bootstrap token generated",
        bootstrapToken: "token",
      },
    ]);
  });
});

describe("the ambient logger", () => {
  // tests/setup.ts silences the ambient logger for the suite; each test here
  // points it at its own buffer and hands it back silent.
  function capturing() {
    const lines: string[] = [];
    configureLogger(
      { TREMA_LOG_FORMAT: "logfmt", TREMA_LOG_LEVEL: "debug" },
      { write: (line) => lines.push(line), now: () => new Date("2026-07-24T10:00:00.000Z") },
    );
    return lines;
  }

  afterEach(() => {
    configureLogger({ TREMA_LOG_FORMAT: "logfmt", TREMA_LOG_LEVEL: "silent" });
  });

  it("writes through the configured root logger", () => {
    const lines = capturing();

    log.info("Server listening", { port: 3000 });

    expect(lines).toEqual([
      'time=2026-07-24T10:00:00.000Z level=info msg="Server listening" port=3000',
    ]);
  });

  it("adds the scoped details for the duration of a call", async () => {
    const lines = capturing();

    await withLogger(log.child({ requestId: "req_1" }), async () => {
      log.info("Request received");
      await Promise.resolve();
      log.info("Request handled", { status: 200 });
    });
    log.info("Outside the request");

    expect(lines[0]).toContain("requestId=req_1");
    expect(lines[1]).toContain("requestId=req_1 status=200");
    expect(lines[2]).not.toContain("requestId");
  });

  it("binds details onto the current scope without wrapping the continuation", async () => {
    const lines = capturing();

    await withLogger(log.child({ requestId: "req_2" }), async () => {
      bindLogger({ orgId: "org_1" });
      await Promise.resolve();
      log.warn("Capability denied", { capability: "items.write" });
    });

    expect(lines[0]).toContain('msg="Capability denied" requestId=req_2 orgId=org_1');
  });

  it("keeps concurrent scopes apart", async () => {
    const lines = capturing();

    await Promise.all([
      withLogger(log.child({ requestId: "req_a" }), async () => {
        await Promise.resolve();
        log.info("First");
      }),
      withLogger(log.child({ requestId: "req_b" }), async () => {
        log.info("Second");
      }),
    ]);

    expect(lines.find((line) => line.includes("First"))).toContain("requestId=req_a");
    expect(lines.find((line) => line.includes("Second"))).toContain("requestId=req_b");
  });
});
