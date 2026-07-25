import { describe, expect, it } from "vitest";

import {
  CronParseError,
  cronTicks,
  isKnownTimezone,
  parseCron,
} from "#/services/schedules/cron.js";

function ticks(expression: string, timezone: string, from: string, to: string): string[] {
  return cronTicks(parseCron(expression), timezone, {
    after: new Date(from),
    until: new Date(to),
    maxLookbackMs: 40 * 24 * 60 * 60 * 1000,
  }).map((tick) => tick.toISOString());
}

describe("parseCron", () => {
  it("reads every field form", () => {
    const cron = parseCron("*/15 9-17 1,15 * 1-5");
    expect([...cron.minutes]).toEqual([0, 15, 30, 45]);
    expect([...cron.hours]).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 17]);
    expect([...cron.daysOfMonth]).toEqual([1, 15]);
    expect(cron.months.size).toBe(12);
    expect([...cron.daysOfWeek]).toEqual([1, 2, 3, 4, 5]);
  });

  it("reads Sunday as both 0 and 7", () => {
    expect([...parseCron("0 0 * * 7").daysOfWeek]).toEqual([0]);
  });

  it("rejects anything that is not five valid fields", () => {
    expect(() => parseCron("0 0 * *")).toThrow(CronParseError);
    expect(() => parseCron("0 0 * * MON")).toThrow(CronParseError);
    expect(() => parseCron("60 0 * * *")).toThrow(CronParseError);
    expect(() => parseCron("0 17-9 * * *")).toThrow(CronParseError);
  });
});

describe("isKnownTimezone", () => {
  it("accepts an IANA zone and rejects anything else", () => {
    expect(isKnownTimezone("Europe/Paris")).toBe(true);
    expect(isKnownTimezone("Mars/Olympus")).toBe(false);
  });
});

describe("cronTicks", () => {
  it("lists the ticks in the window, oldest first", () => {
    expect(
      ticks("*/30 * * * *", "UTC", "2026-07-19T11:00:00.000Z", "2026-07-19T12:10:00.000Z"),
    ).toEqual(["2026-07-19T11:30:00.000Z", "2026-07-19T12:00:00.000Z"]);
  });

  it("excludes the lower bound and includes the upper bound", () => {
    expect(
      ticks("0 * * * *", "UTC", "2026-07-19T11:00:00.000Z", "2026-07-19T12:00:00.000Z"),
    ).toEqual(["2026-07-19T12:00:00.000Z"]);
  });

  it("reads the wall clock in the schedule's zone", () => {
    expect(
      ticks("30 9 * * *", "Europe/Paris", "2026-07-18T12:00:00.000Z", "2026-07-19T12:00:00.000Z"),
    ).toEqual(["2026-07-19T07:30:00.000Z"]);
  });

  it("follows the zone across a daylight saving change instead of a fixed offset", () => {
    // Paris is UTC+2 in August and UTC+1 in November.
    expect(
      ticks("0 9 1 8 *", "Europe/Paris", "2026-07-31T00:00:00.000Z", "2026-08-02T00:00:00.000Z"),
    ).toEqual(["2026-08-01T07:00:00.000Z"]);
    expect(
      ticks("0 9 1 11 *", "Europe/Paris", "2026-10-31T00:00:00.000Z", "2026-11-02T00:00:00.000Z"),
    ).toEqual(["2026-11-01T08:00:00.000Z"]);
  });

  it("never fires for a local time the zone skips", () => {
    // New York has no 02:30 on the spring-forward date.
    expect(
      ticks(
        "30 2 8 3 *",
        "America/New_York",
        "2026-03-07T00:00:00.000Z",
        "2026-03-09T00:00:00.000Z",
      ),
    ).toEqual([]);
  });

  it("fires on either day field when both are restricted", () => {
    // The first of July 2026 is a Wednesday, so the third is the next Friday.
    expect(
      ticks("0 0 1 * 5", "UTC", "2026-06-30T00:00:00.000Z", "2026-07-04T00:00:00.000Z"),
    ).toEqual(["2026-07-01T00:00:00.000Z", "2026-07-03T00:00:00.000Z"]);
  });

  it("looks back no further than the configured window", () => {
    const found = cronTicks(parseCron("0 * * * *"), "UTC", {
      after: new Date("2026-01-01T00:00:00.000Z"),
      until: new Date("2026-07-19T12:00:00.000Z"),
      maxLookbackMs: 3 * 60 * 60 * 1000,
    });
    expect(found.map((tick) => tick.toISOString())).toEqual([
      "2026-07-19T10:00:00.000Z",
      "2026-07-19T11:00:00.000Z",
      "2026-07-19T12:00:00.000Z",
    ]);
  });
});
