import { describe, expect, it } from "vitest";
import { isNavActive, isNavAlert, menuButtonName, navAccessibleName, navAlertTone } from "./nav.js";

describe("isNavActive", () => {
  const settings = { href: "/settings" };

  it("matches the href itself and paths under it", () => {
    expect(isNavActive("/settings", settings)).toBe(true);
    expect(isNavActive("/settings/organization", settings)).toBe(true);
    expect(isNavActive("/settings/organization/members", settings)).toBe(true);
  });

  it("doesn't match a path that only shares the prefix", () => {
    expect(isNavActive("/settingsx", settings)).toBe(false);
    expect(isNavActive("/setting", settings)).toBe(false);
    expect(isNavActive("/", settings)).toBe(false);
  });

  it("matches every activeFor prefix the same way", () => {
    const runs = { href: "/coding", activeFor: ["/reviews", "/triage"] };
    expect(isNavActive("/coding", runs)).toBe(true);
    expect(isNavActive("/reviews", runs)).toBe(true);
    expect(isNavActive("/triage/abc", runs)).toBe(true);
    expect(isNavActive("/reviewsx", runs)).toBe(false);
    expect(isNavActive("/repositories", runs)).toBe(false);
  });

  it("matches the href's sub-paths when it ends in a slash", () => {
    expect(isNavActive("/settings/a", { href: "/settings/" })).toBe(true);
  });

  it("ignores the query and hash", () => {
    expect(isNavActive("/settings?tab=1", settings)).toBe(true);
    expect(isNavActive("/settingsx#a", settings)).toBe(false);
  });

  it("only matches the root on the root", () => {
    expect(isNavActive("/", { href: "/" })).toBe(true);
    expect(isNavActive("/repositories", { href: "/" })).toBe(false);
  });
});

describe("navAccessibleName", () => {
  it("adds the indicator's label after the entry's", () => {
    expect(navAccessibleName({ label: "Runs" })).toBe("Runs");
    expect(
      navAccessibleName({
        label: "Inbox",
        indicator: { kind: "count", value: 4, label: "4 need you" },
      }),
    ).toBe("Inbox, 4 need you");
  });
});

describe("menuButtonName", () => {
  it("counts the drawer's alerts", () => {
    expect(menuButtonName(0)).toBe("Open menu");
    expect(menuButtonName(1)).toBe("Open menu, 1 alert");
    expect(menuButtonName(3)).toBe("Open menu, 3 alerts");
  });
});

describe("navAlertTone", () => {
  const fail = { kind: "dot", tone: "fail", label: "1 agent offline" } as const;
  const run = { kind: "dot", tone: "run", label: "Deliveries retrying" } as const;
  const need = { kind: "count", value: 2, label: "2 need you" } as const;
  const items = { kind: "count", value: 3, label: "3 items", tone: "neutral" } as const;

  it("takes the most pressing alert's tone: failed, then needs you, then running", () => {
    expect(navAlertTone([run, need, fail])).toBe("fail");
    expect(navAlertTone([run, need])).toBe("need");
    expect(navAlertTone([undefined, run])).toBe("run");
  });

  it("is null without an alert: a neutral count is information", () => {
    expect(navAlertTone([])).toBeNull();
    expect(navAlertTone([undefined, items])).toBeNull();
  });
});

describe("isNavAlert", () => {
  it("treats dots and accent counts as alerts, and neutral counts as information", () => {
    expect(isNavAlert(undefined)).toBe(false);
    expect(isNavAlert({ kind: "dot", tone: "fail", label: "1 agent offline" })).toBe(true);
    expect(isNavAlert({ kind: "count", value: 4, label: "4 need you" })).toBe(true);
    expect(isNavAlert({ kind: "count", value: 4, label: "4 need you", tone: "accent" })).toBe(true);
    expect(isNavAlert({ kind: "count", value: 3, label: "3 items", tone: "neutral" })).toBe(false);
  });

  it("names a neutral count in the accessible name like any indicator", () => {
    expect(
      navAccessibleName({
        label: "Backlog",
        indicator: { kind: "count", value: 3, label: "3 items", tone: "neutral" },
      }),
    ).toBe("Backlog, 3 items");
  });
});
