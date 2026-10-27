import { describe, expect, it } from "vitest";
import {
  decidedByLabel,
  identifierError,
  normalizeIdentifier,
  routedBySentence,
} from "./routing-test";

describe("identifierError", () => {
  it.each(["ENG-1", "eng-12", " SOC2-1719 ", "A_B-9"])("accepts %s", (value) => {
    expect(identifierError(value)).toBeNull();
  });

  it.each(["ENG", "ENG-", "ENG-0", "12-3", "ENG 12", "https://linear.app/x/issue/ENG-1"])(
    "refuses %s",
    (value) => {
      expect(identifierError(value)).toBe(
        `${value.trim()} isn't a work item identifier like ENG-123.`,
      );
    },
  );

  it("upper-cases identifiers", () => {
    expect(normalizeIdentifier(" eng-12 ")).toBe("ENG-12");
  });
});

describe("decidedByLabel", () => {
  it("names the rule, the work item match or the default rule", () => {
    expect(
      decidedByLabel({ matched: "rule", rule: { kind: "custom", number: 2, summary: "x" } }),
    ).toBe("Rule 2");
    expect(decidedByLabel({ matched: "match", rule: null })).toBe("Work item match");
    expect(decidedByLabel({ matched: "default", rule: { kind: "default", number: 1 } })).toBe(
      "Default: follow-up of a work item",
    );
    expect(decidedByLabel({ matched: "default", rule: { kind: "default", number: 2 } })).toBe(
      "Default: sub-issue of an epic",
    );
    expect(decidedByLabel({ matched: "default", rule: { kind: "default", number: 3 } })).toBe(
      "Default: asks which repo",
    );
  });
});

describe("routedBySentence", () => {
  it.each([
    ["rule 2 (Team is ENG)", "It matched rule 2 (Team is ENG)."],
    ["work item match (Linear team SOC)", "It matched the work item match (Linear team SOC)."],
    [
      "sub-issue of ENG-10 → rule 2 (Team is ENG)",
      "It is a sub-issue of ENG-10, which matched rule 2 (Team is ENG).",
    ],
    [
      "follow-up of ENG-12 → story of ENG-1",
      "It is a follow-up of ENG-12, which is a story of ENG-1.",
    ],
    [
      "sub-issue of ENG-10 → your selection",
      "It is a sub-issue of ENG-10, which went where someone picked.",
    ],
    [
      "follow-up of ENG-3 → its run",
      "It is a follow-up of ENG-3, which goes where its run builds.",
    ],
    [
      "work item matches of acme/api, acme/web tie",
      "It matched the work item matches of acme/api, acme/web equally.",
    ],
    ["something new", "It was routed by something new."],
  ])("says %s as a sentence", (by, sentence) => {
    expect(routedBySentence(by)).toBe(sentence);
  });

  it("says nothing picked a repo when there's no chain", () => {
    expect(routedBySentence(null)).toBe("No rule, work item match or parent picks a repo for it.");
  });
});
