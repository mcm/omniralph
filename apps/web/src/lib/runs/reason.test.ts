import { describe, expect, it } from "vitest";
import { runReason, runReasonLink, waitingReasonFacts } from "./reason";

describe("runReason for a run waiting on host tools", () => {
  const facts = (hostTools: string[]) =>
    waitingReasonFacts({ code: "host_tools_missing", hostTools })!;

  it("names one, two or three tools as a sorted list, with a link to Fleet", () => {
    expect(runReason(facts(["gh"]))).toBe("Waiting for an agent with gh installed");
    expect(runReason(facts(["opengrep", "gh"]))).toBe(
      "Waiting for an agent with gh and opengrep installed",
    );
    expect(runReason(facts(["c", "a", "b"]))).toBe(
      "Waiting for an agent with a, b and c installed",
    );
    expect(runReasonLink(facts(["gh"]))).toEqual({ label: "Open Fleet", href: "/fleet" });
  });

  it("never names the machine by its old name or the old product", () => {
    for (const tools of [["gh"], ["gh", "opengrep"], ["a", "b", "c"]]) {
      expect(runReason(facts(tools))).not.toMatch(/h[a]rness|\bralph\b/i);
    }
  });

  it("has no facts without a waiting reason, and other reasons have no link", () => {
    expect(waitingReasonFacts(null)).toBeNull();
    expect(waitingReasonFacts(undefined)).toBeNull();
    expect(waitingReasonFacts({ code: "host_tools_missing", hostTools: [] })).toBeNull();
    expect(runReasonLink({ kind: "failed", error: null })).toBeNull();
  });
});
