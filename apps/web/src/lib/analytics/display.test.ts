import { describe, expect, it } from "vitest";
import {
  analyticsHref,
  bucketFor,
  bucketLabel,
  chartSummary,
  dayLabel,
  formatRate,
  formatUsd,
  hasCost,
  parseAnalyticsParams,
  runAnalyticsData,
  unpricedLabel,
  weekLabel,
  type ChartSummaryInput,
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

  it("keeps any repository when it has no repositories to check against", () => {
    expect(parseAnalyticsParams({ repo: "other" })).toEqual({ days: 30, repositoryId: "other" });
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
  it("labels UTC days and weeks", () => {
    expect(dayLabel("2026-10-05")).toBe("Oct 5");
    expect(dayLabel("2026-01-01")).toBe("Jan 1");
    expect(weekLabel("2026-10-05")).toBe("Week of Oct 5");
    expect(bucketLabel("2026-10-05", "day")).toBe("Oct 5");
    expect(bucketLabel("2026-10-05", "week")).toBe("Week of Oct 5");
  });

  it("formats rates", () => {
    expect(formatRate(0)).toBe("0%");
    expect(formatRate(0.054)).toBe("5.4%");
    expect(formatRate(0.75)).toBe("75%");
    expect(formatRate(1)).toBe("100%");
  });

  it("formats US dollars with two decimals", () => {
    expect(formatUsd(0)).toBe("$0.00");
    expect(formatUsd(12.3)).toBe("$12.30");
    expect(formatUsd(1234.567)).toBe("$1,234.57");
  });

  it("counts the attempts a cost leaves out", () => {
    expect(unpricedLabel(1)).toBe("Excludes 1 attempt with no list price");
    expect(unpricedLabel(3)).toBe("Excludes 3 attempts with no list price");
  });
});

describe("bucketFor", () => {
  it("charts 7 and 30 days by day, 90 by week", () => {
    expect(bucketFor(7)).toBe("day");
    expect(bucketFor(30)).toBe("day");
    expect(bucketFor(90)).toBe("week");
  });
});

describe("hasCost", () => {
  it("is true only when the totals carry a cost", () => {
    expect(hasCost({ totals: {} })).toBe(false);
    expect(hasCost({ totals: { costUsd: 0 } })).toBe(true);
    expect(hasCost({ totals: { costUsd: 12.5 } })).toBe(true);
  });
});

describe("runAnalyticsData", () => {
  it("serializes the window dates", () => {
    const from = new Date("2026-09-29T00:00:00Z");
    const to = new Date("2026-10-06T00:00:00Z");
    const data = runAnalyticsData({
      from,
      to,
      bucket: "day",
      buckets: [],
      totals: {} as never,
      byRepository: [],
      byOrganization: [],
    });
    expect(data.from).toBe("2026-09-29T00:00:00.000Z");
    expect(data.to).toBe("2026-10-06T00:00:00.000Z");
  });
});

describe("chartSummary", () => {
  const window = { from: "2026-09-25T00:00:00.000Z", to: "2026-10-25T00:00:00.000Z" };
  const base: Omit<ChartSummaryInput, "points" | "measure"> = {
    title: "Stories completed",
    bucket: "day",
    ...window,
    format: (value) => String(value),
  };

  it("sums a count and names its highest bucket", () => {
    expect(
      chartSummary({
        ...base,
        points: [
          { start: "2026-10-11", value: 5 },
          { start: "2026-10-12", value: 7 },
          { start: "2026-10-13", value: 18 },
        ],
        measure: { kind: "total" },
      }),
    ).toBe("Stories completed per day, Sep 25 to Oct 24: 30 in total, most on Oct 13 (18)");
  });

  it("matches the design's examples", () => {
    expect(
      chartSummary({
        ...base,
        points: [
          { start: "2026-10-03", value: 35 },
          { start: "2026-10-12", value: 7 },
        ],
        measure: { kind: "total" },
      }),
    ).toBe("Stories completed per day, Sep 25 to Oct 24: 42 in total, most on Oct 3 (35)");
    expect(
      chartSummary({
        ...base,
        title: "Success rate",
        points: [
          { start: "2026-10-03", value: 0.8 },
          { start: "2026-10-04", value: null },
          { start: "2026-10-05", value: 1 },
        ],
        format: formatRate,
        measure: { kind: "rate", overall: 0.96 },
      }),
    ).toBe("Success rate per day, Sep 25 to Oct 24: 96% overall, lowest on Oct 3 (80%)");
  });

  it("names weeks", () => {
    expect(
      chartSummary({
        ...base,
        title: "Reviews",
        bucket: "week",
        from: "2026-07-27T00:00:00.000Z",
        points: [
          { start: "2026-07-27", value: 20 },
          { start: "2026-10-19", value: 31 },
        ],
        measure: { kind: "total" },
      }),
    ).toBe("Reviews per week, Jul 27 to Oct 24: 51 in total, most in the week of Oct 19 (31)");
  });

  it("says when there is nothing to sum or rate", () => {
    expect(
      chartSummary({
        ...base,
        points: [{ start: "2026-10-03", value: 0 }],
        measure: { kind: "total" },
      }),
    ).toBe("Stories completed per day, Sep 25 to Oct 24: none");
    expect(
      chartSummary({
        ...base,
        title: "Success rate",
        points: [{ start: "2026-10-03", value: null }],
        measure: { kind: "rate", overall: null },
      }),
    ).toBe("Success rate per day, Sep 25 to Oct 24: no finished attempts");
  });
});
