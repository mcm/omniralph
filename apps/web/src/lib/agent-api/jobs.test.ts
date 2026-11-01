import { JOB_TASK_TYPES } from "@omniralph/shared";
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { isRunSpecJob, jobScopes, runTokenScopes } = await import("./jobs");

describe("jobScopes", () => {
  it("lets legacy ralph jobs push, relay activities and download attachments", () => {
    const ralph = ["credentials:read", "credentials:write", "run:activity", "run:attachments"];
    expect(jobScopes({ type: "ralph.story", taskType: "coding" })).toEqual(ralph);
    expect(jobScopes({ type: "ralph.cleanup", taskType: "coding" })).toEqual(ralph);
    // Routed to the short pool as a query task, but still a ralph job.
    expect(jobScopes({ type: "ralph.describe-pr", taskType: "query" })).toEqual(ralph);
  });

  it("gives every other job read access only", () => {
    for (const job of [
      { type: "review.run", taskType: "review" },
      { type: "review.reply", taskType: "query" },
      { type: "review.learn-rule", taskType: "query" },
      { type: "chat.ask", taskType: "query" },
      { type: "triage.run", taskType: "query" },
      { type: "repo.sync", taskType: "system" },
      { type: "worktree.exec", taskType: "system" },
      // A coding task that isn't a legacy ralph job gets no write access here.
      { type: "task.run", taskType: "coding" },
    ] as const) {
      expect(jobScopes(job)).toEqual(["credentials:read"]);
    }
  });
});

describe("jobScopes of system RPCs", () => {
  it("lets only worktree.cleanup push", () => {
    expect(jobScopes({ type: "worktree.cleanup", taskType: "system" })).toEqual([
      "credentials:read",
      "credentials:write",
    ]);
    // The type alone isn't enough: a non-system job of that type gets read access only.
    expect(jobScopes({ type: "worktree.cleanup", taskType: "query" })).toEqual([
      "credentials:read",
    ]);
  });
});

describe("isRunSpecJob", () => {
  it("gives system RPCs a single token, never a session token", () => {
    expect(isRunSpecJob({ taskId: "builtin:learn-rule", taskType: "query" })).toBe(true);
    expect(isRunSpecJob({ taskId: null, taskType: "query" })).toBe(false);
    expect(isRunSpecJob({ taskId: null, taskType: "system" })).toBe(false);
    expect(isRunSpecJob({ taskId: "builtin:learn-rule", taskType: "system" })).toBe(false);
  });
});

describe("runTokenScopes", () => {
  it("gives session tokens the session scopes for every task type", () => {
    for (const taskType of JOB_TASK_TYPES) {
      expect(runTokenScopes("session", taskType)).toEqual([
        "credentials:read",
        "run:activity",
        "run:attachments",
        "tracker:read",
      ]);
    }
  });

  it("never gives a session token credentials:write", () => {
    for (const taskType of JOB_TASK_TYPES) {
      expect(runTokenScopes("session", taskType)).not.toContain("credentials:write");
    }
  });

  it("lets only coding lifecycle tokens push", () => {
    expect(runTokenScopes("lifecycle", "coding")).toEqual([
      "credentials:read",
      "credentials:write",
    ]);
    for (const taskType of JOB_TASK_TYPES.filter((t) => t !== "coding")) {
      expect(runTokenScopes("lifecycle", taskType)).toEqual(["credentials:read"]);
    }
  });
});
