import * as shared from "./index.js";
import { describe, expect, it } from "vitest";
import {
  type AttemptLabelContext,
  type AttemptStatus,
  describeAttempt,
  LABELED_JOB_TYPES,
  LEGACY_REVIEW_RUN_JOB_TYPE,
  repositoryName,
} from "./attempt-labels.js";

const STATUSES: AttemptStatus[] = [
  "queued",
  "running",
  "completed",
  "failed",
  "canceled",
  "expired",
  "skipped",
];

/** Every exported `*_JOB_TYPE` constant of `@omniralph/shared`, plus the legacy `review.run`. */
const JOB_TYPES = [
  ...Object.entries(shared)
    .filter(([name, value]) => name.endsWith("_JOB_TYPE") && typeof value === "string")
    .map(([, value]) => value as string),
  LEGACY_REVIEW_RUN_JOB_TYPE,
];

const FULL: AttemptLabelContext = {
  workItem: "SOC-1719",
  story: "SOC-1720",
  repository: "acme/web/customer-portal",
  provider: "github",
  pullRequestNumber: 42,
  packageName: "@acme/tools",
  agent: "build-box",
  reviewTask: "Security",
};

/** [type, context, queued/running, completed, failed/canceled/expired]. */
const CASES: [string, AttemptLabelContext, string, string, string][] = [
  ["ralph.story", FULL, "Building SOC-1720", "Built SOC-1720", "Couldn't build SOC-1720"],
  [
    "ralph.story",
    { workItem: "SOC-1719" },
    "Building SOC-1719",
    "Built SOC-1719",
    "Couldn't build SOC-1719",
  ],
  ["ralph.story", {}, "Building this run", "Built this run", "Couldn't build this run"],
  ["ralph.request", FULL, "Working on SOC-1719", "Worked on SOC-1719", "Couldn't work on SOC-1719"],
  [
    "ralph.request",
    { repository: "acme/web/customer-portal" },
    "Working on a request in customer-portal",
    "Worked on a request in customer-portal",
    "Couldn't work on a request in customer-portal",
  ],
  [
    "ralph.request",
    {},
    "Working on a request in this run",
    "Worked on a request in this run",
    "Couldn't work on a request in this run",
  ],
  [
    "ralph.describe-pr",
    { workItem: "SOC-1719", provider: "gitlab" },
    "Writing the merge request description for SOC-1719",
    "Wrote the merge request description for SOC-1719",
    "Couldn't write the merge request description for SOC-1719",
  ],
  [
    "ralph.describe-pr",
    FULL,
    "Writing the pull request description for SOC-1719",
    "Wrote the pull request description for SOC-1719",
    "Couldn't write the pull request description for SOC-1719",
  ],
  [
    "ralph.describe-pr",
    {},
    "Writing the pull request description for this run",
    "Wrote the pull request description for this run",
    "Couldn't write the pull request description for this run",
  ],
  [
    "ralph.push",
    FULL,
    "Pushing the SOC-1720 branch",
    "Pushed the SOC-1720 branch",
    "Couldn't push the SOC-1720 branch",
  ],
  [
    "ralph.push",
    {},
    "Pushing the branch for this run",
    "Pushed the branch for this run",
    "Couldn't push the branch for this run",
  ],
  [
    "ralph.prepare",
    { story: "SOC-1721" },
    "Running the preparation commands for SOC-1721",
    "Ran the preparation commands for SOC-1721",
    "Couldn't run the preparation commands for SOC-1721",
  ],
  [
    "worktree.exec",
    { story: "SOC-1721" },
    "Running the preparation commands for SOC-1721",
    "Ran the preparation commands for SOC-1721",
    "Couldn't run the preparation commands for SOC-1721",
  ],
  [
    "worktree.exec",
    {},
    "Running the preparation commands for this run",
    "Ran the preparation commands for this run",
    "Couldn't run the preparation commands for this run",
  ],
  [
    "ralph.cleanup",
    { workItem: "SOC-1719" },
    "Cleaning up the SOC-1719 worktree",
    "Cleaned up the SOC-1719 worktree",
    "Couldn't clean up the SOC-1719 worktree",
  ],
  [
    "worktree.cleanup",
    { workItem: "SOC-1719" },
    "Cleaning up the SOC-1719 worktree",
    "Cleaned up the SOC-1719 worktree",
    "Couldn't clean up the SOC-1719 worktree",
  ],
  [
    "worktree.cleanup",
    {},
    "Cleaning up the worktree for this run",
    "Cleaned up the worktree for this run",
    "Couldn't clean up the worktree for this run",
  ],
  [
    "ralph.prepare",
    {},
    "Running the preparation commands for this run",
    "Ran the preparation commands for this run",
    "Couldn't run the preparation commands for this run",
  ],
  [
    "ralph.cleanup",
    {},
    "Cleaning up the worktree for this run",
    "Cleaned up the worktree for this run",
    "Couldn't clean up the worktree for this run",
  ],
  [
    "repo.sync",
    FULL,
    "Syncing customer-portal",
    "Synced customer-portal",
    "Couldn't sync customer-portal",
  ],
  ["repo.sync", {}, "Syncing the repo", "Synced the repo", "Couldn't sync the repo"],
  [
    "install",
    FULL,
    "Installing @acme/tools on build-box",
    "Installed @acme/tools on build-box",
    "Couldn't install @acme/tools on build-box",
  ],
  ["install", {}, "Installing a package", "Installed a package", "Couldn't install a package"],
  [
    "review.task",
    FULL,
    "Running the Security review on pull request #42 in customer-portal",
    "Ran the Security review on pull request #42 in customer-portal",
    "Couldn't run the Security review on pull request #42 in customer-portal",
  ],
  [
    "review.task",
    { provider: "gitlab", pullRequestNumber: 7, repository: "group/api" },
    "Reviewing merge request !7 in api",
    "Reviewed merge request !7 in api",
    "Couldn't review merge request !7 in api",
  ],
  [
    "review.task",
    {},
    "Reviewing the pull request",
    "Reviewed the pull request",
    "Couldn't review the pull request",
  ],
  [
    "review.run",
    { provider: "github", pullRequestNumber: 42 },
    "Reviewing pull request #42",
    "Reviewed pull request #42",
    "Couldn't review pull request #42",
  ],
  [
    "review.run",
    {},
    "Reviewing the pull request",
    "Reviewed the pull request",
    "Couldn't review the pull request",
  ],
  [
    "review.correlate",
    FULL,
    "Combining the review findings for pull request #42 in customer-portal",
    "Combined the review findings for pull request #42 in customer-portal",
    "Couldn't combine the review findings for pull request #42 in customer-portal",
  ],
  [
    "review.correlate",
    {},
    "Combining the review findings for the pull request",
    "Combined the review findings for the pull request",
    "Couldn't combine the review findings for the pull request",
  ],
  [
    "review.reply",
    { provider: "gitlab", pullRequestNumber: 7 },
    "Replying to a review comment on merge request !7",
    "Replied to a review comment on merge request !7",
    "Couldn't reply to a review comment on merge request !7",
  ],
  [
    "review.reply",
    {},
    "Replying to a review comment on the pull request",
    "Replied to a review comment on the pull request",
    "Couldn't reply to a review comment on the pull request",
  ],
  [
    "review.learn-rule",
    FULL,
    "Learning a review rule from feedback in customer-portal",
    "Learned a review rule from feedback in customer-portal",
    "Couldn't learn a review rule from feedback in customer-portal",
  ],
  [
    "review.learn-rule",
    {},
    "Learning a review rule from feedback",
    "Learned a review rule from feedback",
    "Couldn't learn a review rule from feedback",
  ],
  ["triage.run", FULL, "Triaging SOC-1719", "Triaged SOC-1719", "Couldn't triage SOC-1719"],
  ["triage.run", {}, "Triaging this run", "Triaged this run", "Couldn't triage this run"],
  [
    "chat.ask",
    FULL,
    "Answering a question about customer-portal",
    "Answered a question about customer-portal",
    "Couldn't answer a question about customer-portal",
  ],
  ["chat.ask", {}, "Answering a question", "Answered a question", "Couldn't answer a question"],
];

describe("describeAttempt", () => {
  it("labels every job type in use", () => {
    expect(JOB_TYPES.length).toBeGreaterThanOrEqual(17);
    const missing = JOB_TYPES.filter((type) => !LABELED_JOB_TYPES.includes(type));
    expect(missing).toEqual([]);
    for (const type of JOB_TYPES) {
      expect(describeAttempt({ type, status: "completed" })).not.toBe("Ran a background job");
    }
  });

  it("covers every job type in the cases below, with and without context", () => {
    for (const type of JOB_TYPES) {
      const cases = CASES.filter(([caseType]) => caseType === type);
      expect(
        cases.some(([, context]) => Object.keys(context).length === 0),
        type,
      ).toBe(true);
      expect(
        cases.some(([, context]) => Object.keys(context).length > 0),
        type,
      ).toBe(true);
    }
  });

  it.each(CASES)("describes %s (%j)", (type, context, progressive, past, failed) => {
    expect(describeAttempt({ type, status: "queued", context })).toBe(progressive);
    expect(describeAttempt({ type, status: "running", context })).toBe(progressive);
    expect(describeAttempt({ type, status: "completed", context })).toBe(past);
    expect(describeAttempt({ type, status: "failed", context })).toBe(failed);
    const stopped = `Stopped ${progressive.charAt(0).toLowerCase()}${progressive.slice(1)}`;
    expect(describeAttempt({ type, status: "canceled", context })).toBe(stopped);
    expect(describeAttempt({ type, status: "expired", context })).toBe(stopped);
    expect(describeAttempt({ type, status: "completed", context, unfinished: true })).toBe(
      failed.replace("Couldn't", "Tried to"),
    );
    expect(describeAttempt({ type, status: "skipped", context })).toBe(
      failed.replace("Couldn't", "Didn't need to"),
    );
  });

  it("says a canceled story attempt stopped, and an unfinished one tried", () => {
    const context = { story: "BIL-90" };
    expect(describeAttempt({ type: "ralph.story", status: "canceled", context })).toBe(
      "Stopped building BIL-90",
    );
    expect(
      describeAttempt({ type: "ralph.story", status: "completed", context, unfinished: true }),
    ).toBe("Tried to build BIL-90");
    // Only a completed attempt can be unfinished.
    expect(
      describeAttempt({ type: "ralph.story", status: "failed", context, unfinished: true }),
    ).toBe("Couldn't build BIL-90");
  });

  it("treats blank context like missing context", () => {
    expect(
      describeAttempt({
        type: "ralph.story",
        status: "completed",
        context: { story: " ", workItem: "", repository: "/" },
      }),
    ).toBe("Built this run");
    expect(
      describeAttempt({ type: "repo.sync", status: "completed", context: { repository: "" } }),
    ).toBe("Synced the repo");
  });

  it("describes an unknown type without its raw type", () => {
    for (const type of ["sinks.legacy", "constructor", "__proto__", "toString", ""]) {
      expect(describeAttempt({ type, status: "completed", context: FULL })).toBe(
        "Ran a background job",
      );
      expect(describeAttempt({ type, status: "running" })).toBe("Running a background job");
      expect(describeAttempt({ type, status: "failed" })).toBe("Couldn't run a background job");
    }
  });

  it("never says agent or Ralph, and never shows a job type", () => {
    const rawTypes = /\b[a-z]+\.[a-z][a-z-]*\b/;
    const types = [...JOB_TYPES, "unknown.type"];
    for (const type of types) {
      for (const status of STATUSES) {
        for (const context of [FULL, {}, { ...FULL, provider: "gitlab" as const }]) {
          const label = describeAttempt({ type, status, context });
          expect(label).not.toMatch(/harness/i);
          expect(label).not.toMatch(/ralph/i);
          expect(label).not.toMatch(rawTypes);
          for (const jobType of types.filter((t) => t.includes(".")))
            expect(label).not.toContain(jobType);
        }
      }
    }
  });
});

describe("repositoryName", () => {
  it("takes the last path segment", () => {
    expect(repositoryName("acme/web/customer-portal")).toBe("customer-portal");
    expect(repositoryName("customer-portal")).toBe("customer-portal");
    expect(repositoryName("acme/customer-portal/")).toBe("customer-portal");
    expect(repositoryName("")).toBeUndefined();
    expect(repositoryName(null)).toBeUndefined();
  });
});
