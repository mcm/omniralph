import { describe, expect, it } from "vitest";
import { attemptLog, attemptStatus, formatDuration, runUrl } from "./model.js";

describe("the Overview model", () => {
  it.each([
    [0, "0s"],
    [45_000, "45s"],
    [12 * 60_000 + 30_000, "12m"],
    [60 * 60_000, "1h"],
    [65 * 60_000, "1h 5m"],
    [-5_000, "0s"],
  ])("formats %i ms as %s", (ms, text) => {
    expect(formatDuration(ms)).toBe(text);
  });

  it("says how an attempt stands", () => {
    const startedAt = "2026-10-28T10:00:00.000Z";
    const at = (minutes: number) => Date.parse(startedAt) + minutes * 60_000;
    expect(attemptStatus({ startedAt, finishedAt: null, outcome: null }, at(12))).toEqual({
      text: "Running for 12m",
      tone: "run",
    });
    const finishedAt = new Date(at(2)).toISOString();
    expect(attemptStatus({ startedAt, finishedAt, outcome: "canceled" }, at(9))).toEqual({
      text: "Stopped after 2m",
      tone: "neutral",
    });
  });

  it("links the run on the control panel", () => {
    expect(runUrl("https://omniralph.example.com/", "run 1")).toBe(
      "https://omniralph.example.com/runs/run%201",
    );
  });

  it("adds the attempt's live lines it didn't load, once", () => {
    const line = (msg: string, jobId = "job-1") => ({
      time: 1,
      level: "info" as const,
      msg,
      fields: { jobId },
    });
    expect(
      attemptLog("job-1", [line("a")], [line("a"), line("b"), line("c", "job-2")]).map(
        (entry) => entry.msg,
      ),
    ).toEqual(["a", "b"]);
  });
});
