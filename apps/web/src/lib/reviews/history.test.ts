import type { FindingRow, ReviewDetail, ReviewListEntry } from "@omniralph/db";
import { describe, expect, it, vi } from "vitest";
import { formatDuration, formatTokens, parseReviewListParams, reviewListHref } from "./display";

vi.mock("server-only", () => ({}));
const { groupFindingsByFile, reviewDetailView, reviewRow, stopReason } = await import("./history");

describe("parseReviewListParams", () => {
  it("reads known filters and the page", () => {
    expect(parseReviewListParams({ status: "failed", trigger: "mention", page: "3" })).toEqual({
      status: "failed",
      trigger: "mention",
      page: 3,
    });
  });

  it("ignores unknown values and invalid pages", () => {
    for (const page of ["0", "-1", "1.5", "abc", undefined]) {
      expect(parseReviewListParams({ status: "nope", trigger: "cron", page })).toEqual({
        status: null,
        trigger: null,
        page: 1,
      });
    }
  });

  it("takes the first of repeated params", () => {
    expect(parseReviewListParams({ status: ["completed", "failed"], page: ["2", "5"] })).toEqual({
      status: "completed",
      trigger: null,
      page: 2,
    });
  });
});

describe("reviewListHref", () => {
  it("keeps filters and page in search params, omitting defaults", () => {
    expect(reviewListHref("/reviews", { status: null, trigger: null, page: 1 })).toBe("/reviews");
    expect(
      reviewListHref("/repositories/r/reviews", {
        status: "budget_exhausted",
        trigger: "webhook",
        page: 2,
      }),
    ).toBe("/repositories/r/reviews?status=budget_exhausted&trigger=webhook&page=2");
  });

  it("accepts the manual (Re-run) trigger as a filter", () => {
    expect(parseReviewListParams({ trigger: "manual" }).trigger).toBe("manual");
  });

  it("round-trips through parseReviewListParams", () => {
    const params = { status: "skipped", trigger: "mention", page: 4 } as const;
    const query = new URL(reviewListHref("/reviews", params), "https://x").searchParams;
    expect(parseReviewListParams(Object.fromEntries(query))).toEqual(params);
  });
});

const finding = (over: Partial<FindingRow>): FindingRow => ({
  id: "f",
  reviewId: "r",
  path: "a.ts",
  startLine: 1,
  endLine: 1,
  severity: "low",
  category: "bug",
  title: "t",
  body: "b",
  suggestion: null,
  confidence: 0.5,
  scmCommentId: null,
  status: "open",
  supersededByFindingId: null,
  sourceTaskIds: [],
  mergedIntoFindingId: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
  ...over,
});

describe("groupFindingsByFile", () => {
  it("groups by file in first-seen order and sorts findings by line", () => {
    const groups = groupFindingsByFile([
      finding({ id: "1", path: "b.ts", startLine: 20 }),
      finding({ id: "2", path: "a.ts", startLine: 5 }),
      finding({ id: "3", path: "b.ts", startLine: 3, endLine: 9 }),
    ]);
    expect(groups.map((g) => [g.path, g.findings.map((f) => f.id)])).toEqual([
      ["b.ts", ["3", "1"]],
      ["a.ts", ["2"]],
    ]);
  });
});

describe("view mapping", () => {
  const repository = {
    id: "repo",
    provider: "gitlab" as const,
    fullPath: "group/api",
    baseUrl: "https://gitlab.example.com/",
  };

  it("maps a list entry to serializable props with the MR link", () => {
    const entry: ReviewListEntry = {
      id: "r1",
      repository,
      prNumber: 7,
      prTitle: "Add things",
      headSha: "a".repeat(40),
      trigger: "webhook",
      status: "completed",
      profile: { id: "quick", name: "Quick" },
      agent: null,
      findingCounts: { critical: 1, high: 0, medium: 0, low: 0, info: 0 },
      tokensIn: 900,
      tokensOut: 100,
      budget: 50_000,
      durationMs: 1234,
      error: null,
      createdAt: new Date("2026-10-05T10:00:00Z"),
    };
    expect(reviewRow(entry)).toMatchObject({
      prUrl: "https://gitlab.example.com/group/api/-/merge_requests/7",
      profileName: "Quick",
      tokensUsed: 1000,
      createdAt: "2026-10-05T10:00:00.000Z",
    });
  });

  it("maps a failed review's detail with its error and stop reason", () => {
    const detail: ReviewDetail = {
      review: {
        id: "r2",
        reviewRunId: null,
        taskId: "builtin:review-pr",
        repositoryId: "repo",
        prNumber: 3,
        prTitle: null,
        headSha: "c".repeat(40),
        baseSha: "d".repeat(40),
        trigger: "mention",
        status: "failed",
        profileId: "deep",
        tokensIn: 0,
        tokensOut: 0,
        budget: 1,
        durationMs: null,
        model: "claude-opus-5-5",
        harnessId: null,
        skippedFiles: [{ path: "big.lock", reason: "excluded" }],
        summaryCommentId: null,
        summary: null,
        error: "clone failed",
        createdAt: new Date(0),
        updatedAt: new Date(0),
      },
      repository: { ...repository, provider: "github", baseUrl: "https://api.github.com" },
      profile: { id: "deep", name: "Deep" },
      agent: null,
      findings: [finding({})],
      feedback: [],
      supersedingReviewIds: {},
    };
    expect(reviewDetailView(detail)).toMatchObject({
      prUrl: "https://github.com/group/api/pull/3",
      stopReason: "Failed",
      error: "clone failed",
      model: "claude-opus-5-5",
      skippedFiles: [{ path: "big.lock", reason: "excluded" }],
      findingCount: 1,
    });
  });

  it("derives stop reasons from the status", () => {
    expect(stopReason("budget_exhausted")).toMatch(/budget/i);
    expect(stopReason("running")).toBeNull();
  });
});

describe("formatting", () => {
  it("formats durations and token counts", () => {
    expect(formatDuration(null)).toBeNull();
    expect(formatDuration(850)).toBe("850 ms");
    expect(formatDuration(42_000)).toBe("42 s");
    expect(formatDuration(185_000)).toBe("3 min 5 s");
    expect(formatTokens(999)).toBe("999");
    expect(formatTokens(1234)).toBe("1.2k");
    expect(formatTokens(200_000)).toBe("200k");
    expect(formatTokens(1_500_000)).toBe("1.5M");
  });
});
