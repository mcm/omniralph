import { describe, expect, it } from "vitest";
import type { RunDetail } from "@/lib/api/runs";
import { attemptDuration } from "./attempt-list";
import {
  isFailedAttempt,
  isLiveAttempt,
  lastFeedback,
  moreEvents,
  selectedAttempt,
  selectedTab,
  stepAttempts,
  stepRetry,
} from "./step-attempts";
import { retriedStepId } from "./use-run-actions";
import { attempt, epicRunDetail, NOW_AT, storyStep } from "./test-fixtures";

const run = (actions: Partial<RunDetail["details"]["actions"]["retry"]> = {}) => {
  const detail = epicRunDetail({
    attempts: [
      attempt("a3", { step: "2", status: "running" }),
      attempt("a2", { step: "2", status: "failed" }),
      attempt("a1", { step: "1" }),
    ],
  });
  return {
    ...detail,
    details: {
      ...detail.details,
      actions: {
        stop: true,
        retry: { run: false, storyIds: [], attemptIds: [], ...actions },
      },
    },
  };
};

describe("stepAttempts and selectedAttempt", () => {
  it("lists the step's attempts, newest first, and picks the URL's or the latest", () => {
    const attempts = stepAttempts(run(), { id: "2" });
    expect(attempts.map((a) => a.id)).toEqual(["a3", "a2"]);
    expect(selectedAttempt(attempts, "a2")?.id).toBe("a2");
    expect(selectedAttempt(attempts, null)?.id).toBe("a3");
    expect(selectedAttempt(attempts, "a1")?.id).toBe("a3");
    expect(selectedAttempt([], null)).toBeUndefined();
  });
});

describe("selectedTab", () => {
  it("is the URL's tab when the panel has it, else Transcript", () => {
    const tabs = ["transcript", "diff", "attempts"];
    expect(selectedTab(tabs, "attempts")).toBe("attempts");
    expect(selectedTab(tabs, "diff")).toBe("diff");
    expect(selectedTab(tabs, "findings")).toBe("transcript");
    expect(selectedTab(tabs, null)).toBe("transcript");
  });
});

describe("attempt states", () => {
  it("tells live and failed attempts", () => {
    expect(["queued", "running"].map((status) => isLiveAttempt({ status } as never))).toEqual([
      true,
      true,
    ]);
    expect(isLiveAttempt({ status: "completed" })).toBe(false);
    expect(isFailedAttempt({ status: "failed" })).toBe(true);
    expect(isFailedAttempt({ status: "expired" })).toBe(true);
    expect(isFailedAttempt({ status: "canceled" })).toBe(false);
  });
});

describe("lastFeedback", () => {
  const story = { ...storyStep("2", "running"), lastFeedback: "Tests failed." };

  it("shows while the story's last attempt didn't complete", () => {
    expect(lastFeedback(story, [attempt("a", { status: "failed" })])).toBe("Tests failed.");
    expect(lastFeedback(story, [attempt("a", { status: "running" })])).toBe("Tests failed.");
    expect(lastFeedback(story, [])).toBe("Tests failed.");
  });

  it("is null once it completed, without feedback, or for other steps", () => {
    expect(lastFeedback(story, [attempt("a", { status: "completed" })])).toBeNull();
    expect(lastFeedback(storyStep("2", "running"), [])).toBeNull();
    expect(
      lastFeedback(
        { kind: "attempt", id: "t", label: "Turn", status: "failed", durationMs: 0 },
        [],
      ),
    ).toBeNull();
  });
});

describe("moreEvents", () => {
  it("counts the hidden events", () => {
    expect(moreEvents(1)).toBe("1 more event");
    expect(moreEvents(442)).toBe("442 more events");
  });
});

describe("stepRetry", () => {
  const steps = run().steps;
  const [done, running] = [steps[0]!, steps[1]!];

  it("is Re-run story for a finished story the run can retry", () => {
    expect(stepRetry(run({ storyIds: ["1"] }), done, undefined)).toEqual({
      label: "Re-run story",
      target: { kind: "story", storyId: "1" },
    });
  });

  it("is Retry story for another story the run can retry", () => {
    expect(stepRetry(run({ storyIds: ["2"], attemptIds: ["a2"] }), running, { id: "a2" })).toEqual({
      label: "Retry story",
      target: { kind: "story", storyId: "2" },
    });
  });

  it("is Retry attempt for the shown attempt the run can retry", () => {
    expect(stepRetry(run({ attemptIds: ["a2"] }), running, { id: "a2" })).toEqual({
      label: "Retry attempt",
      target: { kind: "attempt", attemptId: "a2" },
    });
    expect(stepRetry(run({ attemptIds: ["a2"] }), running, { id: "a3" })).toBeNull();
  });

  it("is none when the run's actions allow neither", () => {
    expect(stepRetry(run(), running, { id: "a3" })).toBeNull();
  });
});

describe("retriedStepId", () => {
  it("marks the step of a retried attempt", () => {
    const detail = run();
    expect(
      retriedStepId(detail.steps, { kind: "attempt", attemptId: "a2" }, undefined, detail.attempts),
    ).toBe("2");
    // A turn's step is its attempt.
    expect(retriedStepId(detail.steps, { kind: "attempt", attemptId: "t1" }, undefined)).toBe("t1");
  });
});

describe("attemptDuration", () => {
  it("is start to finish, or to now while it runs", () => {
    const now = Date.parse(NOW_AT(0));
    expect(attemptDuration({ startedAt: NOW_AT(-30), finishedAt: NOW_AT(-18) }, now)).toBe("12m");
    expect(attemptDuration({ startedAt: NOW_AT(-10), finishedAt: null }, now)).toBe("10m");
    expect(attemptDuration({ startedAt: null, finishedAt: null }, now)).toBeNull();
  });
});
