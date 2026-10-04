import { describe, expect, it } from "vitest";
import { isNavItemActive, navGroups } from "@/lib/navigation";

describe("navGroups", () => {
  it("lists the Omniralph sections", () => {
    const labels = navGroups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toEqual(["Repositories", "Agents", "Jobs", "Admin"]);
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
