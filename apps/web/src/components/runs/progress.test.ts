import { describe, expect, it } from "vitest";
import type { RunStep } from "@/lib/api/runs";
import {
  formatDuration,
  progressTitle,
  stepState,
  stepStatusLine,
  stepsToProgress,
} from "./progress";
import { storyStep } from "./test-fixtures";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;

describe("stepState", () => {
  it.each([
    ["completed", "done"],
    ["manual", "waiting"],
    ["waiting", "waiting"],
    ["running", "running"],
    // Waiting for an agent isn't running: a queued run's bar stays empty.
    ["queued", "pending"],
    ["failed", "failed"],
    ["exhausted", "failed"],
    ["budget_exhausted", "failed"],
    ["blocked", "blocked"],
    ["canceled", "canceled"],
    ["skipped", "canceled"],
    ["pending", "pending"],
    ["expired", "pending"],
  ] as const)("maps %s to %s", (status, state) => {
    expect(stepState(status)).toBe(state);
  });
});

describe("formatDuration", () => {
  it("formats seconds, minutes and hours", () => {
    expect(formatDuration(45_000)).toBe("45s");
    expect(formatDuration(13 * MINUTE + 20_000)).toBe("13m");
    expect(formatDuration(3 * HOUR + 31 * MINUTE + 5_000)).toBe("3h 31m");
    expect(formatDuration(2 * HOUR)).toBe("2h");
    expect(formatDuration(0)).toBe("0s");
  });
});

describe("stepsToProgress", () => {
  it("maps every kind of step to its label, state and duration", () => {
    const steps: RunStep[] = [
      storyStep("1", "completed", 13 * MINUTE),
      storyStep("2", "manual"),
      storyStep("3", "blocked"),
      storyStep("4", "exhausted", 45_000),
      storyStep("5", "canceled"),
      {
        kind: "review_pass",
        id: "p",
        taskName: "Security",
        status: "budget_exhausted",
        tokens: { in: 0, out: 0 },
        durationMs: null,
        openFindings: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      },
      {
        kind: "correlation",
        id: "c",
        label: "Merge the findings",
        status: "skipped",
        tokens: { in: 0, out: 0 },
        durationMs: null,
      },
      { kind: "attempt", id: "t", label: "Answered the question", status: "queued", durationMs: 0 },
    ];
    expect(stepsToProgress(steps).steps).toEqual([
      { id: "1", label: "Story 1", state: "done", meta: "13m" },
      { id: "2", label: "Story 2", state: "waiting" },
      { id: "3", label: "Story 3", state: "blocked" },
      { id: "4", label: "Story 4", state: "failed", meta: "45s" },
      { id: "5", label: "Story 5", state: "canceled" },
      { id: "p", label: "Security", state: "failed" },
      { id: "c", label: "Merge the findings", state: "canceled" },
      { id: "t", label: "Answered the question", state: "pending" },
    ]);
  });

  it("sums the steps' durations into the count line's suffix", () => {
    expect(
      stepsToProgress([
        storyStep("1", "completed", 2 * HOUR),
        storyStep("2", "completed", HOUR + 31 * MINUTE),
        storyStep("3", "canceled"),
      ]).summarySuffix,
    ).toBe("3h 31m");
    expect(
      stepsToProgress([
        storyStep("1", "completed", 10 * MINUTE),
        storyStep("2", "running", 3 * MINUTE),
      ]).summarySuffix,
    ).toBe("13m");
    expect(stepsToProgress([storyStep("1", "completed", 45_000)]).summarySuffix).toBe("45s");
  });

  it("leaves the suffix out when nothing took time", () => {
    expect(stepsToProgress([storyStep("1", "pending")]).summarySuffix).toBeUndefined();
    expect(stepsToProgress([])).toEqual({ steps: [], summarySuffix: undefined });
  });
});

describe("progressTitle", () => {
  it("titles an epic Epic progress in the Inbox, and every kind by its steps otherwise", () => {
    expect(progressTitle("epic", "link")).toBe("Epic progress");
    expect(progressTitle("epic", "select")).toBe("Stories");
    expect(progressTitle("review", "link")).toBe("Review passes");
    expect(progressTitle("review", "select")).toBe("Review passes");
    for (const kind of ["request", "triage", "ask"] as const) {
      expect(progressTitle(kind, "link")).toBe("Turns");
      expect(progressTitle(kind, "select")).toBe("Turns");
    }
  });
});

describe("stepStatusLine", () => {
  it("reads the step's state, toned like its dot", () => {
    expect(stepStatusLine(storyStep("2", "running"))).toEqual({ tone: "run", state: "Running" });
    expect(stepStatusLine(storyStep("3", "exhausted")).tone).toBe("fail");
    expect(stepStatusLine(storyStep("4", "manual"))).toEqual({
      tone: "need",
      state: "Waiting on you",
    });
    expect(stepStatusLine(storyStep("1", "completed")).tone).toBe("neutral");
  });
});
