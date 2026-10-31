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
  queued: "neutral",
  running: "run",
  waiting: "need",
  completed: "good",
  failed: "fail",
  stopped: "warn",
  skipped: "neutral",
};

describe("runRowLabel", () => {
  for (const kind of RUN_KINDS) {
    for (const status of RUN_STATUSES) {
      it(`labels a ${status} ${kind} "${KIND[kind]}", its dot "${KIND[kind]}, ${STATE[status]}"`, () => {
        expect(runRowLabel({ kind, status, progress: null })).toEqual({
          label: KIND[kind],
          statusLabel: `${KIND[kind]}, ${STATE[status]}`,
          story: null,
          tone: TONE[status],
        });
      });
    }
  }

  it("counts the story a running epic is on, for its badge", () => {
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 1, total: 4 } }),
    ).toEqual({ label: "Epic", statusLabel: "Epic, running", story: "Story 2 of 4", tone: "run" });
    // Never past the last story.
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 4, total: 4 } }).story,
    ).toBe("Story 4 of 4");
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 0, total: 0 } }).story,
    ).toBeNull();
  });

  it("numbers the running story by its place in execution order when the row has it", () => {
    // Two done (one canceled), but the running story is the second to run.
    expect(
      runRowLabel({ kind: "epic", status: "running", progress: { done: 2, total: 5, current: 2 } })
        .story,
    ).toBe("Story 2 of 5");
  });

  it("counts stories only for a running epic", () => {
    expect(
      runRowLabel({ kind: "epic", status: "failed", progress: { done: 1, total: 4 } }).story,
    ).toBeNull();
    expect(
      runRowLabel({ kind: "review", status: "running", progress: { done: 1, total: 3 } }).story,
    ).toBeNull();
  });
});
