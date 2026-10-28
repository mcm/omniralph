import { describe, expect, it } from "vitest";
import { formatBytes, relativeTime } from "./format.js";

describe("formatBytes", () => {
  it.each([
    [0, "0 B"],
    [999, "999 B"],
    [512_000, "512 KB"],
    [4_200_000_000, "4.2 GB"],
    [120_000_000_000, "120 GB"],
    [999_960, "1 MB"],
    [2_500_000_000_000, "2.5 TB"],
  ])("%d → %s", (bytes, text) => expect(formatBytes(bytes)).toBe(text));
});

describe("relativeTime", () => {
  const now = Date.parse("2026-10-28T10:42:00.000Z");
  it.each([
    ["2026-10-28T10:41:30.000Z", "just now"],
    ["2026-10-28T10:41:00.000Z", "1 minute ago"],
    ["2026-10-28T10:32:00.000Z", "10 minutes ago"],
    ["2026-10-28T08:42:00.000Z", "2 hours ago"],
    ["2026-10-25T10:42:00.000Z", "3 days ago"],
  ])("%s → %s", (iso, text) => expect(relativeTime(iso, now)).toBe(text));
});
