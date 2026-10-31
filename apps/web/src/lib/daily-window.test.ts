import { describe, expect, it } from "vitest";
import {
  currentDailyWindow,
  dailyWindowStart,
  msUntilNextDailyWindow,
  nextDailyWindow,
} from "./daily-window";

const at = (iso: string) => new Date(iso);
const ms = (iso: string) => Date.parse(iso);

describe("daily window", () => {
  it("starts at 03:15 UTC on the given day", () => {
    expect(dailyWindowStart(at("2026-10-31T23:59:00Z"))).toBe(ms("2026-10-31T03:15:00Z"));
    expect(dailyWindowStart(at("2026-11-01T00:00:00Z"))).toBe(ms("2026-11-01T03:15:00Z"));
  });

  it("is the previous day's window just before the start", () => {
    const now = at("2026-10-31T03:14:59.999Z");
    expect(currentDailyWindow(now)).toBe(ms("2026-10-30T03:15:00Z"));
    expect(nextDailyWindow(now)).toBe(ms("2026-10-31T03:15:00Z"));
  });

  it("is the day's window at and after the start", () => {
    for (const now of [at("2026-10-31T03:15:00Z"), at("2026-10-31T18:00:00Z")]) {
      expect(currentDailyWindow(now)).toBe(ms("2026-10-31T03:15:00Z"));
      expect(nextDailyWindow(now)).toBe(ms("2026-11-01T03:15:00Z"));
    }
  });

  it("crosses midnight UTC, months and years", () => {
    expect(nextDailyWindow(at("2026-10-31T23:59:59Z"))).toBe(ms("2026-11-01T03:15:00Z"));
    expect(currentDailyWindow(at("2026-11-01T00:00:00Z"))).toBe(ms("2026-10-31T03:15:00Z"));
    expect(nextDailyWindow(at("2026-11-01T00:00:00Z"))).toBe(ms("2026-11-01T03:15:00Z"));
    expect(currentDailyWindow(at("2027-01-01T01:00:00Z"))).toBe(ms("2026-12-31T03:15:00Z"));
  });

  it("measures the time left until the next window start", () => {
    expect(msUntilNextDailyWindow(at("2026-10-31T03:14:59.999Z"))).toBe(1);
    expect(msUntilNextDailyWindow(at("2026-10-31T03:15:00Z"))).toBe(24 * 3600_000);
    expect(msUntilNextDailyWindow(at("2026-10-31T18:00:00Z"))).toBe(
      ms("2026-11-01T03:15:00Z") - ms("2026-10-31T18:00:00Z"),
    );
  });

  it("adds whole days to the time left until the next window start", () => {
    const now = at("2026-10-31T18:00:00Z");
    expect(new Date(now.getTime() + msUntilNextDailyWindow(now, 6)).toISOString()).toBe(
      "2026-11-07T03:15:00.000Z",
    );
    expect(msUntilNextDailyWindow(at("2026-10-31T03:14:59.999Z"), 29)).toBe(29 * 24 * 3600_000 + 1);
  });
});
