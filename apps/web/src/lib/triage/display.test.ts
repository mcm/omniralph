import { describe, expect, it } from "vitest";
import { formatDuration, parseTriageRunListParams, triageRunListHref } from "./display";

describe("triage list params", () => {
  it("parses a known status and the page", () => {
    expect(parseTriageRunListParams({ status: "failed", page: "3" })).toEqual({
      status: "failed",
      page: 3,
    });
    expect(parseTriageRunListParams({ status: "bogus" })).toEqual({ status: null, page: 1 });
  });

  it("builds the list's URL without defaults", () => {
    expect(triageRunListHref("/triage", { status: null, page: 1 })).toBe("/triage");
    expect(triageRunListHref("/triage", { status: "running", page: 2 })).toBe(
      "/triage?status=running&page=2",
    );
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(42_000)).toBe("42s");
    expect(formatDuration(65_000)).toBe("1m 05s");
    expect(formatDuration(3_725_000)).toBe("1h 02m");
  });
});
