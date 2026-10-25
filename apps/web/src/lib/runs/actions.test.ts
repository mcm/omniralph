import { describe, expect, it } from "vitest";
import { runActions, storyRetryable } from "./actions";

const open = { merged: false, closed: false };

describe("runActions", () => {
  it("retries a failed, stopped or waiting run, never a busy or finished one", () => {
    for (const status of ["failed", "stopped", "waiting"] as const) {
      expect(runActions({ kind: "triage", status }, "member", {}).retry.run).toBe(true);
    }
    for (const status of ["queued", "running", "completed", "skipped"] as const) {
      expect(runActions({ kind: "review", status }, "member", {}).retry.run).toBe(false);
    }
  });

  it("retries a request run whose newest request attempt didn't succeed, even once it completed", () => {
    const attempt = (id: string, status: string) => ({
      id,
      type: "ralph.request",
      status,
      step: id,
    });
    for (const status of ["failed", "canceled", "expired"]) {
      const attempts = [attempt("r2", status), attempt("r1", "completed")];
      expect(
        runActions({ kind: "request", status: "completed" }, "member", { attempts }).retry.run,
      ).toBe(true);
    }
    const succeeded = [attempt("r2", "completed"), attempt("r1", "failed")];
    expect(
      runActions({ kind: "request", status: "completed" }, "member", { attempts: succeeded }).retry
        .run,
    ).toBe(false);
    // An epic isn't retried as a whole once it completed.
    expect(
      runActions({ kind: "epic", status: "completed" }, "member", {
        attempts: [attempt("r2", "failed")],
      }).retry.run,
    ).toBe(false);
  });

  it("stops unfinished epics and requests, for any member", () => {
    expect(runActions({ kind: "epic", status: "running" }, "admin", {}).stop).toBe(true);
    expect(runActions({ kind: "request", status: "waiting" }, "admin", {}).stop).toBe(true);
    expect(runActions({ kind: "epic", status: "running" }, "member", {}).stop).toBe(true);
    expect(runActions({ kind: "epic", status: "completed" }, "admin", {}).stop).toBe(false);
    expect(runActions({ kind: "triage", status: "running" }, "admin", {}).stop).toBe(false);
  });

  it("retries the newest attempt of each step that failed, was canceled or expired", () => {
    const attempts = [
      { id: "a4", type: "ralph.story", status: "completed", step: "s1" },
      { id: "a3", type: "ralph.story", status: "failed", step: "s1" },
      { id: "a2", type: "ralph.story", status: "expired", step: "s2" },
      { id: "a1", type: "ralph.describe-pr", status: "canceled", step: null },
      { id: "a0", type: "ralph.story", status: "failed", step: "s2" },
    ];
    expect(runActions({ kind: "epic", status: "stopped" }, "member", { attempts }).retry).toEqual({
      run: true,
      storyIds: [],
      attemptIds: ["a2", "a1"],
    });
    // A busy run, and a finished epic, retry no attempt.
    for (const status of ["running", "queued", "completed"] as const) {
      expect(runActions({ kind: "epic", status }, "member", { attempts }).retry.attemptIds).toEqual(
        [],
      );
    }
    // A finished ask or review still retries its failed attempt.
    expect(
      runActions({ kind: "review", status: "completed" }, "member", { attempts }).retry.attemptIds,
    ).toEqual(["a2", "a1"]);
  });

  it("retries stories of a stopped epic, and re-runs a completed story of a finished one", () => {
    const stories = [
      { id: "done", status: "completed", pullRequest: open },
      { id: "out", status: "exhausted", pullRequest: open },
      { id: "manual", status: "manual", pullRequest: null },
      { id: "merged", status: "completed", pullRequest: { merged: true, closed: true } },
      { id: "closed", status: "exhausted", pullRequest: { merged: false, closed: true } },
    ];
    expect(
      runActions({ kind: "epic", status: "stopped" }, "member", { stories }).retry.storyIds,
    ).toEqual(["done", "out"]);
    expect(
      runActions({ kind: "epic", status: "completed" }, "member", { stories }).retry.storyIds,
    ).toEqual(["done"]);
    expect(
      runActions({ kind: "epic", status: "running" }, "member", { stories }).retry.storyIds,
    ).toEqual([]);
    expect(
      runActions({ kind: "request", status: "stopped" }, "member", { stories }).retry.storyIds,
    ).toEqual([]);
    expect(storyRetryable("waiting", { id: "p", status: "pending", pullRequest: null })).toBe(true);
    expect(storyRetryable("waiting", { id: "r", status: "running", pullRequest: null })).toBe(
      false,
    );
  });
});
