import { describe, expect, it } from "vitest";
import { runHref, runListHref } from "./links";

const REPO = "0b7c2a7e-6f43-4c0a-9a43-2f1c3e0d5a11";

describe("Runs screen links", () => {
  it("links a run by its ID", () => {
    expect(runHref("5f0c1b8e-1d2a-4c3b-9e4f-6a7b8c9d0e1f")).toBe(
      "/runs/5f0c1b8e-1d2a-4c3b-9e4f-6a7b8c9d0e1f",
    );
  });

  it("opens a run on a step, attempt and tab", () => {
    expect(runHref("r1", { step: "s 1", attempt: "a1", tab: "attempts" })).toBe(
      "/runs/r1?step=s+1&attempt=a1&tab=attempts",
    );
    expect(runHref("r1", { step: "s1", attempt: null, tab: "findings" })).toBe(
      "/runs/r1?step=s1&tab=findings",
    );
    expect(runHref("r1", {})).toBe("/runs/r1");
  });

  it("builds list URLs without empty filters", () => {
    expect(runListHref()).toBe("/runs");
    expect(runListHref({ kind: [], status: [], repositoryId: null })).toBe("/runs");
    expect(
      runListHref({
        kind: ["epic", "request"],
        status: ["queued", "running", "waiting"],
        repositoryId: REPO,
      }),
    ).toBe(
      `/runs?kind=epic&kind=request&status=queued&status=running&status=waiting&repository=${REPO}`,
    );
  });
});
