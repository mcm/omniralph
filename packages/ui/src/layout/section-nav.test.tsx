import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { UiProvider, type LinkProps } from "../provider/ui-provider.js";
import { SectionNav, sectionNavItemName, type SectionNavGroup } from "./section-nav.js";

const groups: SectionNavGroup[] = [
  {
    label: "Organization",
    items: [
      { label: "General", href: "/settings/general" },
      { label: "Members", href: "/settings/members" },
    ],
  },
  {
    label: "Connections",
    items: [
      {
        label: "GitLab",
        href: "/settings/connections/gitlab/1",
        indicator: { tone: "fail", label: "1 failed delivery" },
      },
      { label: "Add connection", href: "/settings/connections/new" },
    ],
  },
  { label: "Advanced", items: [] },
];

function renderNav(currentPath: string, extra: Partial<Parameters<typeof SectionNav>[0]> = {}) {
  return render(
    <SectionNav
      title="Settings"
      badge={<span>Acme</span>}
      currentPath={currentPath}
      groups={groups}
      {...extra}
    />,
  );
}

describe("SectionNav", () => {
  it("renders a nav named by its title, with the title and badge visible", () => {
    renderNav("/settings/general");
    const nav = screen.getByRole("navigation", { name: "Settings" });
    expect(within(nav).getByRole("heading", { level: 2, name: "Settings" })).toBeTruthy();
    expect(within(nav).getByText("Acme")).toBeTruthy();
  });

  it("renders one list per group under a visible group heading", () => {
    renderNav("/settings/general");
    const nav = screen.getByRole("navigation", { name: "Settings" });
    const headings = within(nav).getAllByRole("heading", { level: 3 });
    expect(headings.map((heading) => heading.textContent)).toEqual(["Organization", "Connections"]);
    const organization = within(nav).getByRole("list", { name: "Organization" });
    expect(
      within(organization)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]),
    ).toEqual([
      ["General", "/settings/general"],
      ["Members", "/settings/members"],
    ]);
    const connections = within(nav).getByRole("list", { name: "Connections" });
    expect(within(connections).getAllByRole("listitem")).toHaveLength(2);
  });

  it("leaves out a group without items", () => {
    renderNav("/settings/general");
    expect(screen.queryByText("Advanced")).toBeNull();
    expect(screen.queryByRole("list", { name: "Advanced" })).toBeNull();
    expect(screen.getAllByRole("list")).toHaveLength(2);
  });

  it("marks the active entry with aria-current=page, matching like isNavActive", () => {
    const { rerender } = renderNav("/settings/members");
    const current = () =>
      screen
        .getAllByRole("link")
        .filter((link) => link.getAttribute("aria-current") === "page")
        .map((link) => link.textContent);
    expect(current()).toEqual(["Members"]);
    // A deeper path and a query string still match; a longer sibling name does not.
    rerender(
      <SectionNav title="Settings" currentPath="/settings/members/invite?x=1" groups={groups} />,
    );
    expect(current()).toEqual(["Members"]);
    rerender(<SectionNav title="Settings" currentPath="/settings/membersx" groups={groups} />);
    expect(current()).toEqual([]);
    rerender(
      <SectionNav title="Settings" currentPath="/settings/connections/new" groups={groups} />,
    );
    expect(current()).toEqual(["Add connection"]);
  });

  it("draws a coral dot whose label joins the entry's accessible name", () => {
    renderNav("/settings/general");
    const link = screen.getByRole("link", { name: "GitLab, 1 failed delivery" });
    expect(link.getAttribute("href")).toBe("/settings/connections/gitlab/1");
    const dot = link.querySelector(".or-dot")!;
    expect(dot.className).toContain("or-dot--fail");
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    // Entries without an indicator are named by their text and draw no dot.
    const general = screen.getByRole("link", { name: "General" });
    expect(general.querySelector(".or-dot")).toBeNull();
    expect(general.hasAttribute("aria-label")).toBe(false);
  });

  it("names entries with sectionNavItemName", () => {
    expect(sectionNavItemName({ label: "GitLab" })).toBe("GitLab");
    expect(
      sectionNavItemName({
        label: "GitLab",
        indicator: { tone: "fail", label: "2 failed deliveries" },
      }),
    ).toBe("GitLab, 2 failed deliveries");
  });

  it("takes a heading level, with group headings one below", () => {
    renderNav("/settings", { headingLevel: 1 });
    expect(screen.getByRole("heading", { level: 1, name: "Settings" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 2 })).toHaveLength(2);
  });

  it("links through the UiProvider link component", () => {
    function TestLink(props: LinkProps) {
      return <a data-test-link="" {...props} />;
    }
    render(
      <UiProvider linkComponent={TestLink}>
        <SectionNav title="Settings" currentPath="/settings/general" groups={groups} />
      </UiProvider>,
    );
    for (const link of screen.getAllByRole("link")) {
      expect(link.hasAttribute("data-test-link")).toBe(true);
    }
  });

  it("renders no keyboard-shortcut text", () => {
    const { container } = renderNav("/settings/general");
    expect(container.querySelector("kbd")).toBeNull();
    expect(container.textContent).not.toMatch(/⌘|Ctrl\+|Alt\+|Shift\+/);
  });
});
