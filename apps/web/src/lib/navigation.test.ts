import { describe, expect, it } from "vitest";
import { isNavItemActive, navGroups, navGroupsForRole } from "@/lib/navigation";

describe("navGroups", () => {
  it("lists the Omniralph sections", () => {
    const labels = navGroups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toEqual(["Repositories", "Agents", "Jobs", "Users"]);
  });
});

describe("navGroupsForRole", () => {
  const labels = (role: "admin" | "member") =>
    navGroupsForRole(role).map((g) => [g.label, g.items.map((i) => i.label)]);

  it("shows admin pages to admins", () => {
    expect(labels("admin")).toEqual([
      ["Navigation", ["Repositories", "Agents", "Jobs"]],
      ["Admin", ["Users"]],
    ]);
  });

  it("hides admin pages and empty groups from members", () => {
    expect(labels("member")).toEqual([["Navigation", ["Repositories", "Agents", "Jobs"]]]);
  });
});

describe("isNavItemActive", () => {
  it("matches the page and its sub-pages", () => {
    expect(isNavItemActive("/agents", "/agents")).toBe(true);
    expect(isNavItemActive("/agents", "/agents/abc")).toBe(true);
  });

  it("does not match sibling paths with a shared prefix", () => {
    expect(isNavItemActive("/agents", "/agentsx")).toBe(false);
    expect(isNavItemActive("/jobs", "/agents")).toBe(false);
  });
});
