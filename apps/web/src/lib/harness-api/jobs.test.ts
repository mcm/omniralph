import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

const { jobScopes } = await import("./jobs");

describe("jobScopes", () => {
  it("lets legacy ralph jobs push, relay activities and download attachments", () => {
    const ralph = ["credentials:read", "credentials:write", "ralph:activity", "ralph:attachments"];
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
      // A coding task that isn't a legacy ralph job gets no write access here.
      { type: "task.run", taskType: "coding" },
    ] as const) {
      expect(jobScopes(job)).toEqual(["credentials:read"]);
    }
  });
});
