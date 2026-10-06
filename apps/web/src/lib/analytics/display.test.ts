import { describe, expect, it } from "vitest";
import {
  analyticsData,
  analyticsHref,
  dayLabel,
  formatRate,
  overallAverageTokens,
  parseAnalyticsParams,
  ralphAnalyticsData,
  ralphDailyRows,
} from "./display";

const repo = "6f1c2a64-6d1e-4f43-9a55-2a0b8f0c4e11";

describe("parseAnalyticsParams", () => {
  it("reads the range and a known repository", () => {
    expect(parseAnalyticsParams({ days: "7", repo }, [repo])).toEqual({
      days: 7,
      repositoryId: repo,
    });
    expect(parseAnalyticsParams({ days: ["90", "7"] }, [])).toEqual({
      days: 90,
      repositoryId: null,
    });
  });

  it("defaults to 30 days and ignores unknown values", () => {
    for (const days of [undefined, "14", "abc", "-7"]) {
      expect(parseAnalyticsParams({ days, repo: "other" }, [repo])).toEqual({
        days: 30,
        repositoryId: null,
      });
    }
  });
});

describe("analyticsHref", () => {
  it("omits defaults", () => {
    expect(analyticsHref("/analytics", { days: 30, repositoryId: null })).toBe("/analytics");
    expect(analyticsHref("/analytics", { days: 7, repositoryId: repo })).toBe(
      `/analytics?days=7&repo=${repo}`,
    );
  });

  it("round-trips through parseAnalyticsParams", () => {
    const params = { days: 90, repositoryId: repo } as const;
    const search = new URL(analyticsHref("/analytics", params), "http://x").searchParams;
    expect(parseAnalyticsParams(Object.fromEntries(search), [repo])).toEqual(params);
  });
});

describe("formatting", () => {
  it("labels UTC days", () => {
    expect(dayLabel("2026-10-05")).toBe("Oct 5");
    expect(dayLabel("2026-01-01")).toBe("Jan 1");
  });

  it("formats rates", () => {
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(0.054)).toBe("5.4%");
    expect(formatRate(0.75)).toBe("75%");
    expect(formatRate(1)).toBe("100%");
  });

  it("weights the overall average by reviews", () => {
    const profile = (reviews: number, averageTokens: number) => ({
      profileId: "p",
      profileName: "P",
      reviews,
      averageTokens,
    });
    expect(overallAverageTokens([])).toBe(0);
    expect(overallAverageTokens([profile(2, 600), profile(3, 2267)])).toBe(1600);
  });

  it("serializes the window dates", () => {
    const data = analyticsData({
      from: new Date("2026-09-29T00:00:00Z"),
      to: new Date("2026-10-06T00:00:00Z"),
      totals: { reviews: 0, tokensIn: 0, tokensOut: 0 },
      daily: [],
      byProfile: [],
      reviewsByStatus: {
        queued: 0,
        running: 0,
        completed: 0,
        failed: 0,
        budget_exhausted: 0,
        skipped: 0,
      },
      findingsBySeverity: { critical: 0, high: 0, medium: 0, low: 0, info: 0 },
      dismissalsByRepository: [],
      jobsByAgent: [],
    });
    expect(data.from).toBe("2026-09-29T00:00:00.000Z");
    expect(data.to).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("ralph analytics", () => {
  const runs = { completed: 1, waiting: 0, stopped: 0, failed: 2, running: 0 };
  const day = (date: string, tokensIn: number, tokensOut: number) => ({
    date,
    tokensIn,
    tokensOut,
  });

  it("puts ralph and review tokens of each day side by side with its runs and stories", () => {
    const stories = { firstAttempt: 2, afterRetries: 1, exhausted: 0, blocked: 1 };
    expect(
      ralphDailyRows(
        {
          daily: [
            { ...day("2026-10-04", 100, 10), runs, stories },
            { ...day("2026-10-05", 0, 0), runs, stories },
          ],
        },
        { daily: [{ ...day("2026-10-05", 400, 40), reviews: 2 }] },
      ),
    ).toEqual([
      { day: "Oct 4", ralphTokens: 110, reviewTokens: 0, ...runs, ...stories },
      { day: "Oct 5", ralphTokens: 0, reviewTokens: 440, ...runs, ...stories },
    ]);
  });

  it("serializes the window dates", () => {
    const data = ralphAnalyticsData({
      from: new Date("2026-09-29T00:00:00Z"),
      to: new Date("2026-10-06T00:00:00Z"),
      totals: { runs: 0, jobs: 0, tokensIn: 0, tokensOut: 0 },
      daily: [],
      runsByOutcome: runs,
      storyOutcomes: { firstAttempt: 0, afterRetries: 0, exhausted: 0, blocked: 0 },
      averageAttempts: 0,
    });
    expect(data.from).toBe("2026-09-29T00:00:00.000Z");
    expect(data.to).toBe("2026-10-06T00:00:00.000Z");
  });
});
