import { describe, expect, it } from "vitest";
import { formatTokens, routedByParts, tokensText } from "./details";

describe("routedByParts", () => {
  it("makes badges of the teams, projects and labels a route names", () => {
    expect(routedByParts("team `SOC` and label `product:portal`")).toEqual([
      { kind: "team", name: "SOC" },
      { kind: "text", text: " and " },
      { kind: "label", name: "product:portal" },
    ]);
    expect(
      routedByParts("work item match (Team is SOC, project Customer Portal, label billing)"),
    ).toEqual([
      { kind: "text", text: "work item match: " },
      { kind: "team", name: "SOC" },
      { kind: "text", text: ", " },
      { kind: "project", name: "Customer Portal" },
      { kind: "text", text: ", " },
      { kind: "label", name: "billing" },
    ]);
  });

  it("keeps other routes as text", () => {
    expect(routedByParts("your selection")).toEqual([{ kind: "text", text: "your selection" }]);
    expect(routedByParts("rule 3 (Labels contains any of backend)")).toEqual([
      { kind: "text", text: "rule 3 (Labels contains any of backend)" },
    ]);
    expect(routedByParts("work item match (Team is SOC, no project)")).toEqual([
      { kind: "text", text: "work item match: " },
      { kind: "team", name: "SOC" },
      { kind: "text", text: ", no project" },
    ]);
  });
});

describe("tokensText", () => {
  it("reads in and out in compact form", () => {
    expect(tokensText({ in: 45_200_000, out: 225_000 })).toBe("45.2M in · 225k out");
    expect(tokensText({ in: 0, out: 950 })).toBe("0 in · 950 out");
    expect(formatTokens(8_400)).toBe("8.4k");
  });
});
