/** A rejected cron expression or time zone. */
export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CronParseError";
  }
}

/** One parsed five-field cron expression, as the set of values each field selects. */
export interface CronExpression {
  minutes: ReadonlySet<number>;
  hours: ReadonlySet<number>;
  daysOfMonth: ReadonlySet<number>;
  months: ReadonlySet<number>;
  daysOfWeek: ReadonlySet<number>;
  /** True when the expression restricts the day of the month. */
  restrictsDayOfMonth: boolean;
  /** True when the expression restricts the day of the week. */
  restrictsDayOfWeek: boolean;
}

interface FieldRange {
  name: string;
  min: number;
  max: number;
}

const FIELDS: FieldRange[] = [
  { name: "minute", min: 0, max: 59 },
  { name: "hour", min: 0, max: 23 },
  { name: "day of the month", min: 1, max: 31 },
  { name: "month", min: 1, max: 12 },
  { name: "day of the week", min: 0, max: 7 },
];

const WEEKDAYS: Record<string, number> = {
  Sun: 0,
  Mon: 1,
  Tue: 2,
  Wed: 3,
  Thu: 4,
  Fri: 5,
  Sat: 6,
};

const MINUTE_MS = 60_000;

/** How far back a tick evaluation looks. Missed ticks are never made up, only counted. */
export const DEFAULT_MAX_LOOKBACK_MS = 24 * 60 * 60 * 1000;

function parseNumber(token: string, field: FieldRange): number {
  if (!/^\d+$/.test(token)) {
    throw new CronParseError(`Invalid ${field.name} value: ${token}`);
  }
  const value = Number(token);
  if (value < field.min || value > field.max) {
    throw new CronParseError(`The ${field.name} must be between ${field.min} and ${field.max}`);
  }
  return value;
}

function parseField(raw: string, field: FieldRange): { values: Set<number>; restricted: boolean } {
  const values = new Set<number>();
  let restricted = false;

  for (const part of raw.split(",")) {
    const [rangeToken, stepToken] = part.split("/");
    if (rangeToken === undefined || rangeToken === "" || part.split("/").length > 2) {
      throw new CronParseError(`Invalid ${field.name} field: ${raw}`);
    }
    let step = 1;
    if (stepToken !== undefined) {
      step = parseNumber(stepToken, { ...field, min: 1, max: field.max });
      if (step < 1) throw new CronParseError(`The ${field.name} step must be positive`);
      restricted = true;
    }

    let from = field.min;
    let to = field.max;
    if (rangeToken !== "*") {
      restricted = true;
      const bounds = rangeToken.split("-");
      if (bounds.length === 1) {
        from = parseNumber(bounds[0]!, field);
        to = stepToken === undefined ? from : field.max;
      } else if (bounds.length === 2) {
        from = parseNumber(bounds[0]!, field);
        to = parseNumber(bounds[1]!, field);
        if (to < from) throw new CronParseError(`The ${field.name} range is reversed: ${part}`);
      } else {
        throw new CronParseError(`Invalid ${field.name} range: ${part}`);
      }
    }

    for (let value = from; value <= to; value += step) values.add(value);
  }

  if (values.size === 0) throw new CronParseError(`The ${field.name} field selects nothing`);
  return { values, restricted };
}

/**
 * Parses a five-field cron expression: minute, hour, day of the month, month,
 * day of the week. It accepts `*`, ranges, lists, and steps. Names such as
 * `MON` are rejected, so one expression has one reading.
 * @throws {CronParseError} When the expression is not a valid five-field expression.
 */
export function parseCron(expression: string): CronExpression {
  const tokens = expression.trim().split(/\s+/);
  if (tokens.length !== 5) {
    throw new CronParseError("A cron expression has five fields: minute hour day month weekday");
  }

  const parsed = tokens.map((token, index) => parseField(token, FIELDS[index]!));
  const [minute, hour, dayOfMonth, month, dayOfWeek] = parsed as [
    { values: Set<number>; restricted: boolean },
    { values: Set<number>; restricted: boolean },
    { values: Set<number>; restricted: boolean },
    { values: Set<number>; restricted: boolean },
    { values: Set<number>; restricted: boolean },
  ];

  // Cron writes Sunday as both 0 and 7.
  const daysOfWeek = new Set([...dayOfWeek.values].map((day) => (day === 7 ? 0 : day)));

  return {
    minutes: minute.values,
    hours: hour.values,
    daysOfMonth: dayOfMonth.values,
    months: month.values,
    daysOfWeek,
    restrictsDayOfMonth: dayOfMonth.restricted,
    restrictsDayOfWeek: dayOfWeek.restricted,
  };
}

/** Reports whether the runtime knows the IANA time zone. */
export function isKnownTimezone(timezone: string): boolean {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: timezone });
    return true;
  } catch {
    return false;
  }
}

/**
 * @throws {CronParseError} When the runtime does not know the time zone.
 */
export function assertKnownTimezone(timezone: string): void {
  if (!isKnownTimezone(timezone)) {
    throw new CronParseError(`Unknown IANA time zone: ${timezone}`);
  }
}

interface WallClock {
  minute: number;
  hour: number;
  dayOfMonth: number;
  month: number;
  dayOfWeek: number;
}

function wallClock(formatter: Intl.DateTimeFormat, at: Date): WallClock {
  const parts = new Map(
    formatter.formatToParts(at).map(({ type, value }) => [type, value] as const),
  );
  const weekday = parts.get("weekday") ?? "Sun";
  return {
    minute: Number(parts.get("minute")),
    hour: Number(parts.get("hour")) % 24,
    dayOfMonth: Number(parts.get("day")),
    month: Number(parts.get("month")),
    dayOfWeek: WEEKDAYS[weekday] ?? 0,
  };
}

function matches(cron: CronExpression, clock: WallClock): boolean {
  if (!cron.minutes.has(clock.minute)) return false;
  if (!cron.hours.has(clock.hour)) return false;
  if (!cron.months.has(clock.month)) return false;

  const dayOfMonth = cron.daysOfMonth.has(clock.dayOfMonth);
  const dayOfWeek = cron.daysOfWeek.has(clock.dayOfWeek);
  // Standard cron: when both day fields are restricted, either one firing is
  // enough. When only one is restricted, that one decides.
  if (cron.restrictsDayOfMonth && cron.restrictsDayOfWeek) return dayOfMonth || dayOfWeek;
  if (cron.restrictsDayOfMonth) return dayOfMonth;
  if (cron.restrictsDayOfWeek) return dayOfWeek;
  return true;
}

/** The window a tick evaluation covers and how far back it may look. */
export interface CronTicksOptions {
  /** Exclusive lower bound: the latest tick already evaluated. */
  after: Date;
  /** Inclusive upper bound: now. */
  until: Date;
  /**
   * Oldest tick the scan considers, as a distance back from `until`.
   * @defaultValue 24 hours
   */
  maxLookbackMs?: number;
}

/**
 * Lists the ticks the expression selects in the window, oldest first.
 *
 * The scan walks real minute-aligned instants and reads each one's wall clock in
 * the schedule's zone, so daylight saving is resolved by the zone rather than by
 * arithmetic on offsets. A local hour the zone skips has no instants, so it
 * never fires.
 */
export function cronTicks(
  cron: CronExpression,
  timezone: string,
  options: CronTicksOptions,
): Date[] {
  assertKnownTimezone(timezone);
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone: timezone,
    year: "numeric",
    month: "numeric",
    day: "numeric",
    hour: "numeric",
    minute: "numeric",
    weekday: "short",
    hourCycle: "h23",
  });

  const lookback = options.maxLookbackMs ?? DEFAULT_MAX_LOOKBACK_MS;
  const earliest = options.until.getTime() - lookback;
  const from = Math.max(options.after.getTime(), earliest);
  const start = Math.floor(from / MINUTE_MS) * MINUTE_MS + MINUTE_MS;
  const end = Math.floor(options.until.getTime() / MINUTE_MS) * MINUTE_MS;

  const ticks: Date[] = [];
  for (let at = start; at <= end; at += MINUTE_MS) {
    const candidate = new Date(at);
    if (matches(cron, wallClock(formatter, candidate))) ticks.push(candidate);
  }
  return ticks;
}
