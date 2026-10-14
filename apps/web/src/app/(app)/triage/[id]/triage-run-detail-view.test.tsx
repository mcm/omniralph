import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TriageRunDetailView as TriageRunDetail } from "@/lib/triage/display";
import { TriageRunDetailView } from "./triage-run-detail-view";

vi.mock("../../repositories/actions", () => ({}));
vi.mock("@/components/app-header", () => ({ AppHeader: () => null }));
vi.mock("@/components/current-user", () => ({ useCurrentUser: () => ({ role: "member" }) }));

function detail(overrides: Partial<TriageRunDetail> = {}): TriageRunDetail {
  return {
    id: "run-1",
    status: "completed",
    trigger: "label",
    issue: { identifier: "TOOL-7", title: "Add exports", url: "https://linear.app/a/TOOL-7" },
    repository: { provider: "github", fullPath: "acme/app", url: "https://github.com/acme/app" },
    outcome: "prd",
    size: "L",
    openQuestions: 1,
    error: null,
    agent: { id: "h-1", name: "builder" },
    jobCount: 1,
    createdAt: "2026-10-13T09:00:00.000Z",
    updatedAt: "2026-10-13T10:00:00.000Z",
    linearAgentSessionId: "session-1",
    branch: "main",
    pendingReply: null,
    result: {
      summary: "Wrote a PRD with two stories.",
      error: null,
      outcome: {
        outcome: "prd",
        size: "L",
        title: "Add exports",
        description: "## Problem\n\nNo exports.",
        openQuestions: ["Which formats?"],
        stories: [
          { title: "Export CSV", body: "CSV body", priority: 2, dependsOn: [], manual: false },
          { title: "Ask legal", body: "Legal body", priority: 3, dependsOn: [0], manual: true },
        ],
        subIssueUpdates: [],
      },
      usage: { inputTokens: 1200, outputTokens: 300 },
      durationMs: 65_000,
    },
    jobs: [
      {
        id: "22222222-2222-4222-8222-222222222222",
        status: "completed",
        cancelRequested: false,
        deliveryCount: 1,
        error: null,
        agent: { id: "h-1", name: "builder" },
        reply: "CSV only please",
        createdAt: "2026-10-13T09:01:00.000Z",
        finishedAt: "2026-10-13T09:05:00.000Z",
      },
    ],
    activities: [
      {
        id: "a-1",
        jobId: "22222222-2222-4222-8222-222222222222",
        type: "action",
        body: "Grep",
        parameter: "export",
        createdAt: "2026-10-13T09:02:00.000Z",
      },
    ],
    ...overrides,
  };
}

const render = (run: TriageRunDetail) =>
  renderToStaticMarkup(<TriageRunDetailView run={run} year={2026} />);

describe("TriageRunDetailView", () => {
  it("shows the issue, the facts, the result and the jobs", () => {
    const html = render(detail());
    expect(html).toContain("TOOL-7");
    expect(html).toContain("Add exports");
    expect(html).toContain('href="https://linear.app/a/TOOL-7"');
    expect(html).toContain("Triage label");
    expect(html).toContain("acme/app");
    expect(html).toContain("New PRD");
    expect(html).toContain("1,200 / 300");
    expect(html).toContain("1m 05s");
    expect(html).toContain("Wrote a PRD with two stories.");
    expect(html).toContain("Which formats?");
    expect(html).toContain("## Problem");
    expect(html).toContain("Export CSV");
    expect(html).toContain("Manual");
    expect(html).toContain("#1");
    expect(html).toContain("Reply: CSV only please");
    expect(html).toContain("/jobs?job=22222222-2222-4222-8222-222222222222");
    expect(html).toContain("Session activity");
    expect(html).toContain("Grep");
  });

  it("says why a run failed and which reply waits", () => {
    const html = render(
      detail({
        status: "failed",
        error: "the triage ended without a result (error)",
        pendingReply: "Try again with JSON",
        result: null,
      }),
    );
    expect(html).toContain("Triage failed");
    expect(html).toContain("the triage ended without a result (error)");
    expect(html).toContain("Reply waiting");
    expect(html).toContain("Try again with JSON");
    expect(html).not.toContain("Summary");
  });

  it("stands in for a run with no job yet", () => {
    const html = render(
      detail({
        status: "queued",
        issue: null,
        repository: null,
        outcome: null,
        size: null,
        result: null,
        jobs: [],
        activities: [],
        jobCount: 0,
      }),
    );
    expect(html).toContain("Triage");
    expect(html).toContain("Not chosen yet");
    expect(html).toContain("Nothing yet");
  });
});
