export const LOG_FORMATS = ["logfmt", "json"] as const;
export type LogFormat = (typeof LOG_FORMATS)[number];

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];

export const LOG_THRESHOLDS = [...LOG_LEVELS, "silent"] as const;
export type LogThreshold = (typeof LOG_THRESHOLDS)[number];

export type LogDetails = Readonly<Record<string, unknown>>;

export interface LogRecord {
  readonly time: string;
  readonly level: LogLevel;
  readonly message: string;
  readonly details: LogDetails;
}

// The envelope owns these three keys; a detail of the same name is dropped
// rather than allowed to shadow them.
const RESERVED_KEYS = new Set(["time", "level", "msg"]);

const UNQUOTED_LOGFMT_VALUE = /^[!#-<>-~]+$/;
const LOGFMT_KEY_SEPARATORS = /[\s="]+/g;

export function formatRecord(format: LogFormat, record: LogRecord): string {
  return format === "json" ? formatJson(record) : formatLogfmt(record);
}

function formatJson(record: LogRecord): string {
  const line: Record<string, unknown> = {
    time: record.time,
    level: record.level,
    msg: record.message,
  };

  for (const [key, value] of normalizeDetails(record.details)) {
    if (!RESERVED_KEYS.has(key)) line[key] = value;
  }

  return JSON.stringify(line);
}

function formatLogfmt(record: LogRecord): string {
  const pairs = [
    `time=${encodeValue(record.time)}`,
    `level=${record.level}`,
    `msg=${encodeValue(record.message)}`,
  ];

  for (const [key, value] of normalizeDetails(record.details)) {
    if (RESERVED_KEYS.has(key)) continue;
    // logfmt has no nesting: an object becomes one pair per leaf, keyed by path.
    for (const [path, leaf] of flatten(key, value)) {
      pairs.push(`${encodeKey(path)}=${encodeValue(leaf)}`);
    }
  }

  return pairs.join(" ");
}

function normalizeDetails(details: LogDetails): [string, unknown][] {
  const entries: [string, unknown][] = [];

  for (const [key, value] of Object.entries(details)) {
    const normalized = normalize(value, new Set());
    if (normalized !== undefined) entries.push([key, normalized]);
  }

  return entries;
}

/**
 * Reduces a detail value to JSON-representable data: errors keep their class,
 * message, stack, and own fields; cycles become `[circular]` instead of
 * throwing at serialization time.
 */
function normalize(value: unknown, seen: Set<object>): unknown {
  if (value === null || value === undefined) return value;

  switch (typeof value) {
    case "string":
    case "boolean":
      return value;
    case "number":
      return Number.isFinite(value) ? value : String(value);
    case "bigint":
      return value.toString();
    case "function":
    case "symbol":
      return String(value);
  }

  const object = value as object;
  if (seen.has(object)) return "[circular]";
  seen.add(object);

  try {
    if (object instanceof Date) {
      return Number.isNaN(object.getTime()) ? "Invalid Date" : object.toISOString();
    }
    if (object instanceof Error) return normalizeError(object, seen);
    if (Array.isArray(object)) return object.map((entry) => normalize(entry, seen) ?? null);
    if (typeof (object as { toJSON?: unknown }).toJSON === "function") {
      return normalize((object as { toJSON: () => unknown }).toJSON(), seen);
    }
    return normalizeObject(object as Record<string, unknown>, seen);
  } finally {
    seen.delete(object);
  }
}

function normalizeError(error: Error, seen: Set<object>): Record<string, unknown> {
  // name, message, and stack are non-enumerable, so they are read explicitly;
  // the spread picks up fields subclasses add (an OAuth error's `code`).
  const normalized: Record<string, unknown> = {
    ...normalizeObject(error as unknown as Record<string, unknown>, seen),
    name: error.name,
    message: error.message,
  };
  if (error.stack) normalized.stack = error.stack;
  if (error.cause !== undefined) normalized.cause = normalize(error.cause, seen);
  return normalized;
}

function normalizeObject(
  object: Record<string, unknown>,
  seen: Set<object>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(object)) {
    const entry = normalize(value, seen);
    if (entry !== undefined) normalized[key] = entry;
  }

  return normalized;
}

function* flatten(key: string, value: unknown): Generator<[string, unknown]> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    yield [key, value];
    return;
  }

  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length === 0) {
    yield [key, "{}"];
    return;
  }

  for (const [childKey, childValue] of entries) {
    yield* flatten(`${key}.${childKey}`, childValue);
  }
}

function encodeKey(key: string): string {
  const sanitized = key.replace(LOGFMT_KEY_SEPARATORS, "_");
  return sanitized === "" ? "_" : sanitized;
}

function encodeValue(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  const text = typeof value === "string" ? value : JSON.stringify(value);
  if (text === undefined) return '""';
  // JSON string syntax is a superset of what logfmt needs for quoting.
  return UNQUOTED_LOGFMT_VALUE.test(text) ? text : JSON.stringify(text);
}
