import { describe, expect, it } from "vitest";
import { RUN_KINDS, RUN_STATUSES } from "@/lib/api/runs";
import { runRowLabel } from "./labels";

const KIND = { epic: "Epic", request: "Request", review: "Review", triage: "Triage", ask: "Ask" };
const STATE = {
  queued: "queued",
  running: "running",
  waiting: "waiting on you",
  completed: "finished",
  failed: "failed",
  stopped: "stopped",
  skipped: "skipped",
};
const TONE = {
  queued: "run",
  running: "run",
  waiting: "need",
  completed: "neutral",
  failed: "fail",
  stopped: "need",
  skipped: "neutral",
};

describe("runRowLabel", () => {
  for (const kind of RUN_KINDS) {
    for (const status of RUN_STATUSES) {
      it(`labels a ${status} ${kind} without progress "${KIND[kind]} · ${STATE[status]}"`, () => {
        expect(runRowLabel({ kind, status, progress: null })).toEqual({
          label: `${KIND[kind]} · ${STATE[status]}`,
          tone: TONE[status],
        });
      });
    }
  }

  it("counts the story a running epic is on", () => {
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 1, total: 4 } }),
    ).toEqual({ label: "Running · story 2 of 4", tone: "run" });
    // Never past the last story.
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 4, total: 4 } }).label,
    ).toBe("Running · story 4 of 4");
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 0, total: 0 } }).label,
    ).toBe("Epic · running");
  });

  it("counts stories only for a running epic", () => {
    expect(
      runRowLabel({ kind: "epic", status: "failed", progress: { done: 1, total: 4 } }).label,
    ).toBe("Epic · failed");
    expect(
      runRowLabel({ kind: "review", status: "running", progress: { done: 1, total: 3 } }).label,
    ).toBe("Review · running");
  });
});
