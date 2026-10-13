import { describe, expect, it } from "vitest";
import { formatDateTime, formatDateTimeAfter } from "./format-date";

describe("formatDateTimeAfter", () => {
  const earlier = new Date(2026, 9, 5, 15, 4).toISOString();

  it("shows only the time on the same day", () => {
    const iso = new Date(2026, 9, 5, 15, 9).toISOString();
    const text = formatDateTimeAfter(iso, earlier);
    expect(text).toMatch(/3:09/);
    expect(text).not.toMatch(/Oct|2026/);
  });

  it("drops the year in the same year", () => {
    const iso = new Date(2026, 9, 6, 15, 9).toISOString();
    const text = formatDateTimeAfter(iso, earlier);
    expect(text).toMatch(/Oct/);
    expect(text).toMatch(/3:09/);
    expect(text).not.toMatch(/2026/);
  });

  it("shows the full date and time in another year", () => {
    const iso = new Date(2027, 0, 2, 9, 0).toISOString();
    expect(formatDateTimeAfter(iso, earlier)).toBe(formatDateTime(iso));
  });
});
