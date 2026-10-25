import { describe, expect, it } from "vitest";
import { isNavActive, menuButtonName, navAccessibleName } from "./nav.js";

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
