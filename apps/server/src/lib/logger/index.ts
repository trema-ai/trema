import { AsyncLocalStorage } from "node:async_hooks";

import {
  formatRecord,
  type LogDetails,
  type LogFormat,
  type LogLevel,
  type LogThreshold,
} from "./format.js";

export interface Logger {
  debug(message: string, details?: LogDetails): void;
  info(message: string, details?: LogDetails): void;
  warn(message: string, details?: LogDetails): void;
  error(message: string, details?: LogDetails): void;
  /** A logger that repeats `details` on every line — run and request ids. */
  child(details: LogDetails): Logger;
}

export interface LoggerOptions {
  format?: LogFormat;
  level?: LogThreshold;
  details?: LogDetails;
  write?: (line: string) => void;
  now?: () => Date;
}

export interface LoggerEnvironment {
  readonly TREMA_LOG_FORMAT: LogFormat;
  readonly TREMA_LOG_LEVEL: LogThreshold;
}

const RANK: Record<LogThreshold, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
  silent: Number.POSITIVE_INFINITY,
};

// Logs go to stderr so stdout stays a data channel: `trema bootstrap-token`
// pipes its token, and the log lines around it must not land in the pipe.
function writeToStderr(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function createLogger({
  format = "logfmt",
  level = "info",
  details = {},
  write = writeToStderr,
  now = () => new Date(),
}: LoggerOptions = {}): Logger {
  const threshold = RANK[level];

  const emit = (recordLevel: LogLevel, message: string, extra?: LogDetails): void => {
    if (RANK[recordLevel] < threshold) return;
    write(
      formatRecord(format, {
        time: now().toISOString(),
        level: recordLevel,
        message,
        details: extra ? { ...details, ...extra } : details,
      }),
    );
  };

  return {
    debug: (message, extra) => emit("debug", message, extra),
    info: (message, extra) => emit("info", message, extra),
    warn: (message, extra) => emit("warn", message, extra),
    error: (message, extra) => emit("error", message, extra),
    child: (bound) =>
      createLogger({ format, level, details: { ...details, ...bound }, write, now }),
  };
}

export function createLoggerFromEnv(
  env: LoggerEnvironment,
  options: Omit<LoggerOptions, "format" | "level"> = {},
): Logger {
  return createLogger({ ...options, format: env.TREMA_LOG_FORMAT, level: env.TREMA_LOG_LEVEL });
}

// The ambient logger. Server modules import `log` instead of taking a logger
// parameter: `configureLogger` sets what it writes to, and `withLogger` binds
// the ids of the work in flight (request, procedure, org) for the duration of
// a call, so a line logged deep in a service still carries its correlation.
let rootLogger = createLogger();
const scopedLogger = new AsyncLocalStorage<Logger>();

export function configureLogger(
  env: LoggerEnvironment,
  options: Omit<LoggerOptions, "format" | "level"> = {},
): Logger {
  rootLogger = createLoggerFromEnv(env, options);
  return rootLogger;
}

export function withLogger<T>(logger: Logger, run: () => T): T {
  return scopedLogger.run(logger, run);
}

/**
 * Adds details to the scoped logger for the rest of the current call — used by
 * middleware that cannot wrap the continuation it hands to the next handler.
 */
export function bindLogger(details: LogDetails): void {
  scopedLogger.enterWith(currentLogger().child(details));
}

export function currentLogger(): Logger {
  return scopedLogger.getStore() ?? rootLogger;
}

export const log: Logger = {
  debug: (message, details) => currentLogger().debug(message, details),
  info: (message, details) => currentLogger().info(message, details),
  warn: (message, details) => currentLogger().warn(message, details),
  error: (message, details) => currentLogger().error(message, details),
  child: (details) => currentLogger().child(details),
};

export {
  LOG_FORMATS,
  LOG_LEVELS,
  LOG_THRESHOLDS,
  type LogDetails,
  type LogFormat,
  type LogLevel,
  type LogRecord,
  type LogThreshold,
} from "./format.js";
