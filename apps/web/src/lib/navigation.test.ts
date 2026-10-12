import { describe, expect, it } from "vitest";
import { isNavItemActive, navGroups, navGroupsForRole } from "@/lib/navigation";

describe("navGroups", () => {
  it("lists the Omniralph sections", () => {
    const labels = navGroups.flatMap((group) => group.items.map((item) => item.label));
    expect(labels).toEqual([
      "Repositories",
      "Reviews",
      "Ralph runs",
      "Harnesses",
      "Jobs",
      "Analytics",
      "Organization",
      "Agents",
      "Tasks",
      "Profiles",
      "Integrations",
      "Harnesses",
      "Chat accounts",
    ]);
  });

  it("links the harness pages", () => {
    const items = navGroups.flatMap((group) => group.items);
    expect(items).toContainEqual(
      expect.objectContaining({ href: "/harnesses", label: "Harnesses" }),
    );
    expect(items).toContainEqual(
      expect.objectContaining({ href: "/settings/harnesses", label: "Harnesses", adminOnly: true }),
    );
  });

  it("links the agent definitions for every member", () => {
    const items = navGroups.flatMap((group) => group.items);
    const agents = items.find((item) => item.href === "/settings/agents");
    expect(agents).toEqual({ href: "/settings/agents", label: "Agents", icon: "agents" });
  });

  it("links the task definitions for every member", () => {
    const items = navGroups.flatMap((group) => group.items);
    const tasks = items.find((item) => item.href === "/settings/tasks");
    expect(tasks).toEqual({ href: "/settings/tasks", label: "Tasks", icon: "tasks" });
  });
});

describe("navGroupsForRole", () => {
  const labels = (role: "admin" | "member") =>
    navGroupsForRole(role).map((g) => [g.label, g.items.map((i) => i.label)]);

  it("shows admin pages to admins", () => {
    expect(labels("admin")).toEqual([
      ["Navigation", ["Repositories", "Reviews", "Ralph runs", "Harnesses", "Jobs", "Analytics"]],
      [
        "Settings",
        [
          "Organization",
          "Agents",
          "Tasks",
          "Profiles",
          "Integrations",
          "Harnesses",
          "Chat accounts",
        ],
      ],
    ]);
  });

  it("hides admin pages from members", () => {
    expect(labels("member")).toEqual([
      ["Navigation", ["Repositories", "Reviews", "Ralph runs", "Harnesses", "Jobs", "Analytics"]],
      ["Settings", ["Organization", "Agents", "Tasks", "Chat accounts"]],
    ]);
  });
});

describe("isNavItemActive", () => {
  it("matches the page and its sub-pages", () => {
    expect(isNavItemActive("/harnesses", "/harnesses")).toBe(true);
    expect(isNavItemActive("/harnesses", "/harnesses/abc")).toBe(true);
  });

  it("does not match sibling paths with a shared prefix", () => {
    expect(isNavItemActive("/harnesses", "/harnessesx")).toBe(false);
    expect(isNavItemActive("/jobs", "/harnesses")).toBe(false);
  });
});
