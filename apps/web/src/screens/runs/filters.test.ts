import { describe, expect, it } from "vitest";
import {
  hasRunFilters,
  NO_RUN_FILTERS,
  parseRunFilters,
  runFiltersHref,
  runInListHref,
} from "./filters";

const REPO = "0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a11";
const OTHER = "0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a12";

describe("parseRunFilters", () => {
  it("reads repeatable kind, status and repository parameters", () => {
    expect(
      parseRunFilters(
        new URLSearchParams(
          `kind=review&kind=epic&status=failed&status=waiting&repository=${REPO}&repository=${OTHER}`,
        ),
      ),
    ).toEqual({
      kind: ["epic", "review"],
      status: ["waiting", "failed"],
      repository: [REPO, OTHER],
    });
  });

  it("drops page and unknown parameters", () => {
    expect(
      parseRunFilters(new URLSearchParams("page=3&origin=chat&agent=a1&cursor=x&tab=diff")),
    ).toEqual(NO_RUN_FILTERS);
  });

  it("drops unknown values and repeats", () => {
    expect(
      parseRunFilters(
        new URLSearchParams(
          `kind=coding&kind=epic&kind=epic&status=pending&repository=acme&repository=${REPO}&repository=${REPO}`,
        ),
      ),
    ).toEqual({ kind: ["epic"], status: [], repository: [REPO] });
  });

  it("reads nothing from empty params", () => {
    expect(parseRunFilters(new URLSearchParams())).toEqual(NO_RUN_FILTERS);
    expect(hasRunFilters(NO_RUN_FILTERS)).toBe(false);
    expect(hasRunFilters({ ...NO_RUN_FILTERS, status: ["failed"] })).toBe(true);
  });
});

describe("Runs URLs", () => {
  it("writes the filters as repeatable parameters, and keeps them on a run's URL", () => {
    const filters = {
      kind: ["epic" as const],
      status: ["running" as const],
      repository: [REPO, OTHER],
    };
    expect(runFiltersHref(NO_RUN_FILTERS)).toBe("/runs");
    expect(runFiltersHref(filters)).toBe(
      `/runs?kind=epic&status=running&repository=${REPO}&repository=${OTHER}`,
    );
    expect(runInListHref("r1", NO_RUN_FILTERS)).toBe("/runs/r1");
    expect(runInListHref("r1", filters)).toBe(
      `/runs/r1?kind=epic&status=running&repository=${REPO}&repository=${OTHER}`,
    );
  });

  it("adds what the run detail shows: the step, attempt and tab", () => {
    expect(runInListHref("r1", NO_RUN_FILTERS, { step: "s1" })).toBe("/runs/r1?step=s1");
    expect(
      runInListHref(
        "r1",
        { ...NO_RUN_FILTERS, kind: ["epic"] },
        { step: "s1", attempt: "a1", tab: "attempts" },
      ),
    ).toBe("/runs/r1?kind=epic&step=s1&attempt=a1&tab=attempts");
    expect(runInListHref("r1", NO_RUN_FILTERS, { step: null, tab: "" })).toBe("/runs/r1");
  });
});
