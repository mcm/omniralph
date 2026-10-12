import { describe, expect, it } from "vitest";
import { jobIdFromHash, jobListHref, jobPageHref, parseJobListParams, shortJobId } from "./list";

const ID = "0f3c2a1b-4d5e-4f60-8a7b-9c0d1e2f3a4b";

describe("jobs list helpers", () => {
  it("parses the status, page and targeted job", () => {
    expect(parseJobListParams({})).toEqual({ status: null, page: 1, jobId: null });
    expect(parseJobListParams({ status: "failed", page: "3", job: ID.toUpperCase() })).toEqual({
      status: "failed",
      page: 3,
      jobId: ID,
    });
    expect(parseJobListParams({ job: "nope", page: "-1" })).toEqual({
      status: null,
      page: 1,
      jobId: null,
    });
  });

  it("builds list links without defaults", () => {
    expect(jobListHref("/jobs", { status: null, page: 1 })).toBe("/jobs");
    expect(jobListHref("/jobs", { status: "queued", page: 2 })).toBe("/jobs?status=queued&page=2");
  });

  it("links to a job's row and reads it back from the fragment", () => {
    expect(jobPageHref(ID)).toBe(`/jobs?job=${ID}#job-${ID}`);
    expect(jobIdFromHash(`#job-${ID}`)).toBe(ID);
    expect(jobIdFromHash("#job-123")).toBeNull();
    expect(jobIdFromHash("")).toBeNull();
    expect(shortJobId(ID)).toBe("0f3c2a1b…3a4b");
  });
});
