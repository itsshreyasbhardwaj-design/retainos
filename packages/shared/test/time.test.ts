import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  dayKey, startOfDay, dayKeyToMillis, daysBetween, addDays, dayRange,
  weekKey, monthKey, tzOffsetMs, isValidTimezone, bucketKey,
} from "../src/time.ts";

describe("dayKey", () => {
  test("formats as YYYY-MM-DD in UTC", () => {
    assert.equal(dayKey(Date.UTC(2026, 2, 14, 12, 0, 0), "UTC"), "2026-03-14");
  });

  test("respects the reporting timezone across the date line", () => {
    // 2026-03-14T23:30Z is already 2026-03-15 in India (UTC+5:30).
    const ts = Date.UTC(2026, 2, 14, 23, 30, 0);
    assert.equal(dayKey(ts, "UTC"), "2026-03-14");
    assert.equal(dayKey(ts, "Asia/Kolkata"), "2026-03-15");
    // ...and still 2026-03-14 in Los Angeles.
    assert.equal(dayKey(ts, "America/Los_Angeles"), "2026-03-14");
  });
});

describe("dayKeyToMillis", () => {
  test("round-trips through dayKey for every day of a year in a half-hour zone", () => {
    let key = "2026-01-01";
    for (let i = 0; i < 365; i++) {
      assert.equal(dayKey(dayKeyToMillis(key, "Asia/Kolkata"), "Asia/Kolkata"), key, `failed at ${key}`);
      key = addDays(key, 1, "Asia/Kolkata");
    }
  });

  test("resolves local midnight, not UTC midnight", () => {
    const ms = dayKeyToMillis("2026-03-15", "Asia/Kolkata");
    // 2026-03-15T00:00+05:30 === 2026-03-14T18:30Z
    assert.equal(ms, Date.UTC(2026, 2, 14, 18, 30, 0));
  });

  test("handles the US spring-forward day, where 02:00 local does not exist", () => {
    // 8 March 2026 is a DST start in America/New_York.
    const ms = dayKeyToMillis("2026-03-08", "America/New_York");
    assert.equal(dayKey(ms, "America/New_York"), "2026-03-08");
    assert.equal(ms, Date.UTC(2026, 2, 8, 5, 0, 0)); // EST is UTC-5
  });

  test("handles the US fall-back day, where 01:00 local happens twice", () => {
    const ms = dayKeyToMillis("2026-11-01", "America/New_York");
    assert.equal(dayKey(ms, "America/New_York"), "2026-11-01");
    assert.equal(ms, Date.UTC(2026, 10, 1, 4, 0, 0)); // EDT is UTC-4 at midnight
  });
});

describe("daysBetween and addDays", () => {
  test("counts calendar days, not 24-hour periods, across DST", () => {
    // March 2026 in New York contains a 23-hour day. A naive /86400000 would
    // report 30.95 days and round to 31 here only by luck; across the spring
    // boundary specifically, a naive subtraction under-counts.
    assert.equal(daysBetween("2026-03-07", "2026-03-09", "America/New_York"), 2);
    assert.equal(daysBetween("2026-10-31", "2026-11-02", "America/New_York"), 2);
  });

  test("addDays survives DST transitions", () => {
    assert.equal(addDays("2026-03-07", 1, "America/New_York"), "2026-03-08");
    assert.equal(addDays("2026-03-08", 1, "America/New_York"), "2026-03-09");
    assert.equal(addDays("2026-10-31", 1, "America/New_York"), "2026-11-01");
    assert.equal(addDays("2026-11-01", 1, "America/New_York"), "2026-11-02");
  });

  test("addDays crosses month and year boundaries", () => {
    assert.equal(addDays("2026-01-31", 1), "2026-02-01");
    assert.equal(addDays("2026-12-31", 1), "2027-01-01");
    assert.equal(addDays("2028-02-28", 1), "2028-02-29"); // leap year
    assert.equal(addDays("2026-01-01", -1), "2025-12-31");
  });

  test("dayRange is inclusive on both ends", () => {
    const r = dayRange("2026-03-01", "2026-03-05");
    assert.deepEqual(r, ["2026-03-01", "2026-03-02", "2026-03-03", "2026-03-04", "2026-03-05"]);
  });
});

describe("weekKey", () => {
  test("uses ISO-8601 weeks with Monday start", () => {
    // 2026-01-01 is a Thursday, so it belongs to ISO week 1 of 2026.
    assert.equal(weekKey(Date.UTC(2026, 0, 1), "UTC"), "2026-W01");
    // 2026-01-04 is a Sunday: still week 1.
    assert.equal(weekKey(Date.UTC(2026, 0, 4), "UTC"), "2026-W01");
    // 2026-01-05 is the Monday that starts week 2.
    assert.equal(weekKey(Date.UTC(2026, 0, 5), "UTC"), "2026-W02");
  });

  test("assigns early-January days to the previous ISO year when correct", () => {
    // 2027-01-01 is a Friday -> ISO week 53 of 2026.
    assert.equal(weekKey(Date.UTC(2027, 0, 1), "UTC"), "2026-W53");
  });
});

describe("monthKey and bucketKey", () => {
  test("monthKey is timezone aware", () => {
    const ts = Date.UTC(2026, 2, 31, 22, 0, 0); // 1 April in Kolkata
    assert.equal(monthKey(ts, "UTC"), "2026-03");
    assert.equal(monthKey(ts, "Asia/Kolkata"), "2026-04");
  });

  test("bucketKey dispatches on granularity", () => {
    const ts = Date.UTC(2026, 2, 14, 12);
    assert.equal(bucketKey(ts, "day", "UTC"), "2026-03-14");
    assert.equal(bucketKey(ts, "week", "UTC"), "2026-W11");
    assert.equal(bucketKey(ts, "month", "UTC"), "2026-03");
  });
});

describe("tzOffsetMs", () => {
  test("reports known offsets", () => {
    assert.equal(tzOffsetMs(Date.UTC(2026, 0, 15), "UTC"), 0);
    assert.equal(tzOffsetMs(Date.UTC(2026, 0, 15), "Asia/Kolkata"), 5.5 * 3_600_000);
    assert.equal(tzOffsetMs(Date.UTC(2026, 0, 15), "America/New_York"), -5 * 3_600_000);
    assert.equal(tzOffsetMs(Date.UTC(2026, 6, 15), "America/New_York"), -4 * 3_600_000);
  });
});

describe("isValidTimezone", () => {
  test("accepts IANA names and rejects junk", () => {
    assert.equal(isValidTimezone("Asia/Kolkata"), true);
    assert.equal(isValidTimezone("UTC"), true);
    assert.equal(isValidTimezone("Mars/Olympus"), false);
  });
});

describe("startOfDay", () => {
  test("is idempotent", () => {
    const ts = Date.UTC(2026, 2, 14, 17, 45);
    const a = startOfDay(ts, "Asia/Kolkata");
    assert.equal(startOfDay(a, "Asia/Kolkata"), a);
  });
});
