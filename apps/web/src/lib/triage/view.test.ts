import type { RunActivity, TriageRunJob, TriageRunWithJobs } from "@omniralph/db";
import { describe, expect, it } from "vitest";
import { triageJobRun, triageRunDetailView, triageRunRow } from "./view";

const RUN_ID = "11111111-1111-4111-8111-111111111111";

function run(overrides: Partial<TriageRunWithJobs["run"]> = {}): TriageRunWithJobs["run"] {
  return {
    id: RUN_ID,
    organizationId: "org-1",
    linearIssueId: "issue-uuid",
    linearAgentSessionId: "session-1",
    trigger: "mention",
    currentJobId: null,
    status: "completed",
    lastResult: null,
    pendingReply: null,
    createdAt: new Date("2026-10-13T09:00:00.000Z"),
    updatedAt: new Date("2026-10-13T10:00:00.000Z"),
    ...overrides,
  };
}

function job(id: string, context: Record<string, unknown>, overrides: Partial<TriageRunJob> = {}) {
  return {
    id,
    triageRunId: RUN_ID,
    status: "completed",
    deliveryCount: 1,
    cancelRequested: false,
    error: null,
    payload: { trigger: { kind: "linear.triage", context: { triageRunId: RUN_ID, ...context } } },
    agent: { id: "h-1", name: "builder" },
    repository: null,
    createdAt: new Date("2026-10-13T09:01:00.000Z"),
    startedAt: null,
    finishedAt: new Date("2026-10-13T09:05:00.000Z"),
    ...overrides,
  } satisfies TriageRunJob;
}

const issue = {
  identifier: "TOOL-7",
  title: "Add exports",
  url: "https://linear.app/acme/issue/TOOL-7",
};

const result = {
  summary: "Wrote a PRD.",
  error: null,
  outcome: {
    outcome: "prd",
    size: "L",
    title: "Add exports",
    description: "## Problem\n\nNo exports.",
    openQuestions: ["Which formats?"],
    stories: [
      { title: "Export CSV", body: "As a user…", priority: 2, dependsOn: [], manual: false },
    ],
    subIssueUpdates: [],
  },
  usage: { inputTokens: 1200, outputTokens: 300 },
  durationMs: 65_000,
};

describe("triageRunRow", () => {
  it("names the run by the issue its jobs read and sums up its result", () => {
    const row = triageRunRow({
      run: run({ lastResult: result }),
      jobs: [
        job(
          "job-2",
          { reply: "CSV only" },
          {
            repository: {
              id: "repo-1",
              provider: "github",
              fullPath: "acme/app",
              baseUrl: "https://api.github.com",
            },
          },
        ),
        job("job-1", { issue }),
      ],
    });
    expect(row).toMatchObject({
      id: RUN_ID,
      status: "completed",
      trigger: "mention",
      issue,
      repository: { provider: "github", fullPath: "acme/app", url: "https://github.com/acme/app" },
      outcome: "prd",
      size: "L",
      openQuestions: 1,
      error: null,
      agent: { id: "h-1", name: "builder" },
      jobCount: 2,
      createdAt: "2026-10-13T09:00:00.000Z",
    });
  });

  it("leaves out what isn't known yet, and links only web URLs", () => {
    expect(triageRunRow({ run: run({ status: "queued" }), jobs: [] })).toMatchObject({
      issue: null,
      repository: null,
      outcome: null,
      size: null,
      openQuestions: null,
      agent: null,
      jobCount: 0,
    });
    const row = triageRunRow({
      run: run(),
      jobs: [job("job-1", { issue: { ...issue, url: "javascript:alert(1)" } })],
    });
    expect(row.issue).toEqual({ ...issue, url: null });
  });

  it("says why a failed run failed", () => {
    const failed = { ...result, error: "no structured result", outcome: null };
    expect(
      triageRunRow({ run: run({ status: "failed", lastResult: failed }), jobs: [] }).error,
    ).toBe("no structured result");
    expect(
      triageRunRow({
        run: run({ status: "failed" }),
        jobs: [job("job-1", { issue }, { status: "failed", error: "harness crashed" })],
      }).error,
    ).toBe("harness crashed");
    expect(triageRunRow({ run: run({ lastResult: failed }), jobs: [] }).error).toBeNull();
  });
});

describe("triageRunDetailView", () => {
  it("keeps the result, the jobs with their replies and the activities", () => {
    const activity: RunActivity = {
      id: "a-1",
      jobId: "job-1",
      organizationId: "org-1",
      type: "action",
      body: "Read",
      parameter: "src/index.ts",
      createdAt: new Date("2026-10-13T09:02:00.000Z"),
    };
    const view = triageRunDetailView(
      {
        run: run({ lastResult: result, pendingReply: "And JSON?" }),
        jobs: [
          job(
            "job-1",
            { issue, branch: "main", reply: "CSV only" },
            {
              repository: {
                id: "repo-1",
                provider: "gitlab",
                fullPath: "acme/app",
                baseUrl: "https://gitlab.example.com",
              },
            },
          ),
        ],
      },
      [activity],
    );
    expect(view).toMatchObject({
      linearAgentSessionId: "session-1",
      branch: "main",
      pendingReply: "And JSON?",
      result: { summary: "Wrote a PRD.", durationMs: 65_000 },
      jobs: [
        {
          id: "job-1",
          status: "completed",
          reply: "CSV only",
          finishedAt: "2026-10-13T09:05:00.000Z",
        },
      ],
      activities: [
        {
          id: "a-1",
          jobId: "job-1",
          type: "action",
          body: "Read",
          parameter: "src/index.ts",
          createdAt: "2026-10-13T09:02:00.000Z",
        },
      ],
    });
    expect(view.result?.outcome?.stories).toHaveLength(1);
  });

  it("drops a last result that doesn't parse", () => {
    expect(
      triageRunDetailView({ run: run({ lastResult: { bogus: true } }), jobs: [] }, []).result,
    ).toBeNull();
  });
});

describe("triageJobRun", () => {
  it("links a triage job to its run, named by its issue", () => {
    const { payload } = job("job-1", { issue });
    expect(triageJobRun({ type: "triage.run", payload })).toEqual({ id: RUN_ID, label: "TOOL-7" });
    expect(triageJobRun({ type: "triage.run", payload: job("job-1", {}).payload })).toEqual({
      id: RUN_ID,
      label: "Triage",
    });
  });

  it("ignores other jobs", () => {
    const { payload } = job("job-1", { issue });
    expect(triageJobRun({ type: "ralph.story", payload })).toBeNull();
    expect(triageJobRun({ type: "triage.run", payload: {} })).toBeNull();
  });
});
