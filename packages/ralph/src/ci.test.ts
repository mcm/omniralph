import { describe, expect, it } from "vitest";
import { buildCiFailureRequest } from "./ci.js";

describe("buildCiFailureRequest", () => {
  const base = {
    prNumber: 7,
    prUrl: "https://github.com/acme/app/pull/7",
    headSha: "0123456789abcdef",
    branch: "eng-1-task-priority",
  };

  it("lists the failed jobs with their logs and what to do", () => {
    const text = buildCiFailureRequest({
      ...base,
      jobs: [
        {
          name: "CI / test",
          url: "https://github.com/acme/app/actions/runs/5/job/1",
          log: "FAIL a.test.ts\n",
        },
        { name: "CI / build", log: "" },
      ],
    });
    expect(text).toContain(
      "The GitHub Actions checks for pull request #7 (https://github.com/acme/app/pull/7) failed on `0123456`. Fix it on `eng-1-task-priority`:",
    );
    expect(text).toContain(
      "### CI / test (https://github.com/acme/app/actions/runs/5/job/1)\n```\nFAIL a.test.ts\n```",
    );
    expect(text).toContain("### CI / build\n(no log available)");
    expect(text).toContain("push `eng-1-task-priority` so CI runs again");
    expect(text).toContain("Don't skip, disable or weaken tests");
  });

  it("names GitLab pipelines and merge requests, and lists at most 5 jobs", () => {
    const jobs = Array.from({ length: 7 }, (_, i) => ({ name: `test / job${i + 1}`, log: "x" }));
    const text = buildCiFailureRequest({ ...base, term: "merge request", jobs });
    expect(text).toContain("The GitLab CI pipeline for merge request !7");
    expect(text).toContain("### test / job5");
    expect(text).not.toContain("### test / job6");
    expect(text).toContain("(2 more failed jobs not shown.)");
  });

  it("keeps only the end of a long log", () => {
    const text = buildCiFailureRequest({
      ...base,
      jobs: [{ name: "j", log: `${"a".repeat(5000)}END` }],
    });
    expect(text).toContain(`…${"a".repeat(3997)}END`);
    expect(text).not.toContain("a".repeat(4001));
  });
});
