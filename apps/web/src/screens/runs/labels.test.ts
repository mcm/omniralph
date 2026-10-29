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

  it("names the running story's place, not the count of finished ones", () => {
    // Story 3 runs while stories 1, 2 and 5 are done (5 was canceled).
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 3, total: 9, running: 3 } }),
    ).toEqual({ label: "Running · story 3 of 9", tone: "run" });
    // Between stories nothing runs: no story to name.
    expect(
      runRowLabel({
        kind: "epic",
        status: "running",
        progress: { done: 2, total: 4, running: null },
      }).label,
    ).toBe("Epic · running");
  });

  it("counts stories only for a running epic", () => {
    expect(
      runRowLabel({ kind: "epic", status: "failed", progress: { done: 1, total: 4, running: 2 } })
        .label,
    ).toBe("Epic · failed");
    expect(
      runRowLabel({
        kind: "review",
        status: "running",
        progress: { done: 1, total: 3, running: null },
      }).label,
    ).toBe("Review · running");
  });
});
