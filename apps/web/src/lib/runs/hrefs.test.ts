import { describe, expect, it } from "vitest";
import { agentHref, runHref } from "./hrefs";

describe("hrefs", () => {
  it("links an agent to its Fleet page", () => {
    expect(agentHref("a1")).toBe("/fleet/a1");
  });

  it("links a run to its Runs page", () => {
    expect(runHref("r1")).toBe("/runs/r1");
  });
});
