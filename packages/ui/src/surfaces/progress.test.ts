import { describe, expect, it } from "vitest";
import { progressSummary, type StepState } from "./progress.js";

const steps = (...states: StepState[]) => states.map((state) => ({ state }));

describe("progressSummary", () => {
  it("says so when there are no steps", () => {
    expect(progressSummary([])).toBe("No steps yet");
  });

  it("counts all-done steps", () => {
    expect(progressSummary(steps("done", "done", "done"))).toBe("3 of 3 done");
  });

  it("lists the non-zero parts in a fixed order", () => {
    expect(progressSummary(steps("blocked", "done", "waiting", "done"))).toBe(
      "2 of 4 done · 1 waiting on you · 1 blocked",
    );
    expect(
      progressSummary(
        steps("failed", "blocked", "running", "waiting", "pending", "done", "running"),
      ),
    ).toBe("1 of 7 done · 1 waiting on you · 2 running · 1 failed · 1 blocked");
  });

  it("keeps the done count when nothing is done", () => {
    expect(progressSummary(steps("pending", "pending"))).toBe("0 of 2 done");
  });

  it("counts canceled steps last and appends the suffix", () => {
    expect(
      progressSummary(
        steps("done", "done", "done", "done", "done", "done", "done", "done", "canceled"),
        "3h 31m",
      ),
    ).toBe("8 of 9 done · 1 canceled · 3h 31m");
    expect(progressSummary(steps("canceled", "failed", "done"))).toBe(
      "1 of 3 done · 1 failed · 1 canceled",
    );
  });

  it("leaves out an empty suffix and keeps No steps yet without steps", () => {
    expect(progressSummary(steps("done"), "")).toBe("1 of 1 done");
    expect(progressSummary([], "3m")).toBe("No steps yet");
  });
});
