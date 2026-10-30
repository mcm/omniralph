import { describe, expect, it } from "vitest";
import { runActivity } from "./activity";
import { attempt, NOW_AT, runDetail } from "./test-fixtures";

/** A job type as the server stores it ("ralph.story", "repo.sync"). */
const JOB_TYPE = /\b[a-z]+\.[a-z-]+\b/;

describe("runActivity", () => {
  it("starts with the run's creation and routing, oldest last", () => {
    const detail = runDetail(null, {
      status: "running",
      createdAt: NOW_AT(-60),
      details: {
        ...runDetail(null).details,
        routedBy: "team `SOC` and label `product:portal`",
        repository: { id: "r", provider: "gitlab", fullPath: "acme/customer-portal" },
      },
    });
    expect(runActivity(detail, null)).toEqual([
      {
        id: "routed",
        at: NOW_AT(-60),
        text: "Routed by team `SOC` and label `product:portal` to customer-portal",
      },
      { id: "created", at: NOW_AT(-60), text: "Epic started from Linear" },
    ]);
  });

  it("leaves routing out when the run wasn't routed", () => {
    expect(runActivity(runDetail(null, { status: "running" }), null).map((e) => e.id)).toEqual([
      "created",
    ]);
  });

  it("adds each finished attempt's label at its finish, newest first, and a failure's first error line", () => {
    const detail = runDetail(null, {
      status: "running",
      createdAt: NOW_AT(-60),
      attempts: [
        attempt("running", { status: "running", finishedAt: null, label: "Building TOOL-3" }),
        attempt("failed", {
          status: "failed",
          finishedAt: NOW_AT(-10),
          label: "Couldn't build TOOL-2",
          error: "\n  Tests failed: 3 of 40\n    at ralph.story (worker.ts:12)\n",
        }),
        attempt("done", { finishedAt: NOW_AT(-30), label: "Built TOOL-1" }),
      ],
    });
    expect(runActivity(detail, null)).toEqual([
      {
        id: "attempt:failed",
        at: NOW_AT(-10),
        text: "Couldn't build TOOL-2: Tests failed: 3 of 40",
      },
      { id: "attempt:done", at: NOW_AT(-30), text: "Built TOOL-1" },
      { id: "created", at: NOW_AT(-60), text: "Epic started from Linear" },
    ]);
  });

  it("numbers a repeated label by its attempt, oldest first, and leaves a unique one plain", () => {
    const detail = runDetail(null, {
      status: "running",
      createdAt: NOW_AT(-60),
      attempts: [
        attempt("third", { finishedAt: NOW_AT(-10), label: "Built FIX-107" }),
        attempt("first", { finishedAt: NOW_AT(-50), label: "Built FIX-107" }),
        attempt("other", { finishedAt: NOW_AT(-40), label: "Built FIX-108" }),
        attempt("second", { finishedAt: NOW_AT(-30), label: "Built FIX-107" }),
      ],
    });
    expect(runActivity(detail, null).map((entry) => entry.text)).toEqual([
      "Built FIX-107 (attempt 3)",
      "Built FIX-107 (attempt 2)",
      "Built FIX-108",
      "Built FIX-107 (attempt 1)",
      "Epic started from Linear",
    ]);
  });

  it("numbers a story's attempts by its step, whatever each one's label says", () => {
    const detail = runDetail(null, {
      status: "running",
      createdAt: NOW_AT(-60),
      attempts: [
        attempt("built", { finishedAt: NOW_AT(-10), label: "Built FIX-102", step: "s1" }),
        attempt("tried", { finishedAt: NOW_AT(-50), label: "Tried to build FIX-102", step: "s1" }),
        attempt("other", { finishedAt: NOW_AT(-40), label: "Built FIX-103", step: "s2" }),
        attempt("again", { finishedAt: NOW_AT(-30), label: "Tried to build FIX-102", step: "s1" }),
      ],
    });
    expect(runActivity(detail, null).map((entry) => entry.text)).toEqual([
      "Built FIX-102 (attempt 3)",
      "Tried to build FIX-102 (attempt 2)",
      "Built FIX-103",
      "Tried to build FIX-102 (attempt 1)",
      "Epic started from Linear",
    ]);
  });

  it("adds the current reason of a waiting run, and only the event of a stopped or failed one", () => {
    const failed = runDetail(null, { status: "failed", finishedAt: NOW_AT(-5) });
    expect(runActivity(failed, "The run failed. Out of disk.")[0]).toEqual({
      id: "reason",
      at: NOW_AT(-5),
      text: "The run failed",
    });
    const stopped = runDetail(null, { status: "stopped", finishedAt: NOW_AT(-5) });
    expect(runActivity(stopped, "The run was stopped. By hand.")[0]?.text).toBe(
      "The run was stopped",
    );
    const ask = runDetail(null, { kind: "ask", status: "stopped", finishedAt: NOW_AT(-5) });
    expect(runActivity(ask, "The run was stopped.")[0]?.text).toBe("The run was stopped");
    const waiting = runDetail(null, { status: "waiting", finishedAt: null, updatedAt: NOW_AT(-2) });
    expect(runActivity(waiting, "Om is waiting on you.")[0]).toEqual({
      id: "reason",
      at: NOW_AT(-2),
      text: "Om is waiting on you.",
    });
  });

  it("leaves out a failed attempt's error when the reason already says it", () => {
    const detail = runDetail(null, {
      status: "failed",
      finishedAt: NOW_AT(-5),
      attempts: [
        attempt("failed", {
          status: "failed",
          finishedAt: NOW_AT(-10),
          label: "Couldn't triage FIX-322",
          error: "Om ran out of its token budget.",
        }),
      ],
    });
    expect(
      runActivity(detail, "The run failed. Om ran out of its token budget.").map((e) => e.text),
    ).toEqual(["The run failed", "Couldn't triage FIX-322", "Epic started from Linear"]);
  });

  it("leaves the reason out of a running or finished run, or without one", () => {
    for (const status of ["running", "completed", "queued"] as const) {
      expect(
        runActivity(runDetail(null, { status }), "Om is working on it.").map((e) => e.id),
      ).not.toContain("reason");
    }
    expect(runActivity(runDetail(null, { status: "failed" }), null).map((e) => e.id)).not.toContain(
      "reason",
    );
  });

  it("names how each kind of run started", () => {
    const start = (overrides: Parameters<typeof runDetail>[1]) =>
      runActivity(runDetail(null, { status: "running", ...overrides }), null).at(-1)!.text;
    expect(start({ kind: "request", origin: "chat" })).toBe("Request started from a chat");
    expect(start({ kind: "review", origin: "pr_webhook" })).toBe(
      "Review started by a change to the pull request",
    );
    expect(
      start({
        kind: "review",
        origin: "pr_mention",
        pullRequest: { provider: "gitlab", number: 3, url: null },
      }),
    ).toBe("Review started from a mention on the merge request");
    expect(start({ kind: "triage", origin: "triage_label" })).toBe(
      "Triage started by the triage label",
    );
    expect(start({ kind: "ask", origin: "manual" })).toBe("Ask started by hand");
    expect(start({ kind: "epic", origin: "linear_mention" })).toBe(
      "Epic started from a mention in Linear",
    );
  });

  it("never shows a raw job type", () => {
    const detail = runDetail(null, {
      status: "failed",
      details: { ...runDetail(null).details, routedBy: "team `ENG`" },
      repository: { id: "r", provider: "github", fullPath: "acme/web" },
      attempts: [
        attempt("a", { type: "ralph.story", label: "Built TOOL-1" }),
        attempt("b", {
          type: "repo.sync",
          status: "failed",
          label: "Couldn't sync web",
          error: "git fetch failed",
        }),
      ],
    });
    const entries = runActivity(detail, "The run failed.");
    expect(entries).toHaveLength(5);
    for (const entry of entries) expect(entry.text).not.toMatch(JOB_TYPE);
  });
});
