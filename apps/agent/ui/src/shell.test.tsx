// @vitest-environment jsdom
import { screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { NavProblem } from "./state.js";
import { NARROW, WIDE, agentState, fakeApi, renderAgentPage } from "./test/page.js";

function splitView(): HTMLElement {
  return document.querySelector<HTMLElement>(".or-split")!;
}

/** The detail pane's "‹ Agent" link back to the section list, if it has one. */
function backLink(): HTMLElement | null {
  const link = document.querySelector<HTMLElement>(".or-split__detail .or-split__back");
  if (link) expect(link.textContent).toBe("‹ Agent");
  return link;
}

function nav(): HTMLElement {
  return screen.getByRole("navigation", { name: "Agent" });
}

describe("the agent page's layout", () => {
  it("has the top bar: the brand home link, the agent's name and the control panel's host", async () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    expect(screen.getByRole("link", { name: "Omniralph home" }).getAttribute("href")).toBe("/");
    expect(await screen.findByText("build-01")).toBeTruthy();
    // Both facts are badges with their icons (Design rule 1).
    const facts = [...document.querySelectorAll(".agent-topbar__facts .or-ref")];
    expect(facts.map((badge) => badge.textContent?.trim())).toEqual([
      "build-01",
      "omniralph.example.com",
    ]);
    expect(facts[0]!.className).toContain("or-ref--agent");
    expect(facts.every((badge) => badge.querySelector("svg"))).toBe(true);
  });

  it("lists every page in the Activity, Settings and Machine groups, with the theme control", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage();
    const groups = within(nav()).getAllByRole("list");
    const entries = (list: HTMLElement) =>
      within(list)
        .getAllByRole("link")
        .map((link) => [link.textContent, link.getAttribute("href")]);
    expect(within(nav()).getByRole("heading", { level: 1, name: "Agent" })).toBeTruthy();
    expect(groups.map((group) => group.getAttribute("aria-labelledby") && entries(group))).toEqual([
      [
        ["Overview", "/overview"],
        ["Logs", "/logs"],
      ],
      [
        ["Capacity", "/capacity"],
        ["Packages", "/packages"],
        ["Host tools", "/host-tools"],
        ["Version", "/version"],
      ],
      [
        ["Claude", "/claude"],
        ["Storage", "/storage"],
      ],
    ]);
    // "Agent" is the nav's title only, never a group heading too.
    expect(
      within(nav())
        .getAllByRole("heading", { level: 2 })
        .map((heading) => heading.textContent),
    ).toEqual(["Activity", "Settings", "Machine"]);
    const list = screen.getByRole("region", { name: "Agent sections" });
    expect(within(list).getByRole("radiogroup", { name: "Theme" })).toBeTruthy();
  });

  it("shows Overview beside the nav on / when wide, with no back link", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path: "/", width: WIDE });
    expect(splitView().dataset.view).toBe("list");
    expect(screen.getByRole("heading", { level: 2, name: "Overview" })).toBeTruthy();
    expect(within(nav()).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
    expect(backLink()).toBeNull();
  });

  it("makes / the section list when narrow", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path: "/", width: NARROW });
    expect(splitView().dataset.view).toBe("list");
    expect(screen.queryByRole("heading", { level: 2, name: "Overview" })).toBeNull();
    expect(within(nav()).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      null,
    );
  });

  it.each([
    ["/overview", "Overview"],
    ["/logs", "Logs"],
    ["/capacity", "Capacity"],
    ["/packages", "Packages"],
    ["/host-tools", "Host tools"],
    ["/version", "Version"],
    ["/claude", "Claude"],
    ["/storage", "Storage"],
  ])("opens %s alone with a ‹ Agent back link when narrow", (path, title) => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path, width: NARROW });
    expect(splitView().dataset.view).toBe("detail");
    expect(screen.getByRole("heading", { level: 2, name: title })).toBeTruthy();
    // The nav (and its h1) is hidden: the open page carries the h1, inside the main landmark.
    const detail = within(screen.getByRole("main")).getByRole("region", { name: title });
    expect(within(detail).getByRole("heading", { level: 1 }).textContent).toBe("Agent");
    expect(backLink()?.getAttribute("href")).toBe("/");
    expect(within(nav()).getByRole("link", { name: title }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("keeps the page beside the nav when wide", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path: "/capacity", width: WIDE });
    expect(splitView().dataset.view).toBe("detail");
    expect(screen.getByRole("heading", { level: 2, name: "Capacity" })).toBeTruthy();
    expect(screen.getAllByRole("heading", { level: 1 })).toHaveLength(1);
    // Both panes show from 880 px; the stylesheet hides the back link there.
    expect(within(nav()).getByRole("link", { name: "Capacity" })).toBeTruthy();
  });

  it("opens an attempt with Overview active and its own ‹ Overview link", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path: "/attempts/job-1", width: NARROW });
    expect(splitView().dataset.view).toBe("detail");
    expect(backLink()).toBeNull();
    expect(screen.getByRole("link", { name: "‹ Overview" }).getAttribute("href")).toBe("/overview");
    expect(within(nav()).getByRole("link", { name: "Overview" }).getAttribute("aria-current")).toBe(
      "page",
    );
  });

  it("navigates in place from the nav", async () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path: "/", width: NARROW });
    await userEvent.click(within(nav()).getByRole("link", { name: "Storage" }));
    expect(window.location.pathname).toBe("/storage");
    expect(splitView().dataset.view).toBe("detail");
    expect(screen.getByRole("heading", { level: 2, name: "Storage" })).toBeTruthy();
    await userEvent.click(backLink()!);
    expect(window.location.pathname).toBe("/");
    expect(splitView().dataset.view).toBe("list");
  });

  it("says so for an unknown path", () => {
    fakeApi({ "/api/state": { body: agentState() } });
    renderAgentPage({ path: "/nowhere", width: NARROW });
    expect(screen.getByRole("heading", { level: 2, name: "Page not found" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Open Overview" }).getAttribute("href")).toBe(
      "/overview",
    );
    expect(backLink()).toBeTruthy();
  });
});

describe("nav dots", () => {
  const problems: NavProblem[] = [
    { section: "overview", reason: "can't reach the control panel" },
    { section: "host_tools", reason: "gh and opengrep required but not found" },
    { section: "version", reason: "the last update failed" },
    { section: "claude", reason: "not signed in" },
    { section: "storage", reason: "low disk" },
  ];

  it("marks each section /api/state reports a problem for, with the reason in its name", async () => {
    fakeApi({ "/api/state": { body: agentState({ problems }) } });
    renderAgentPage();
    expect(await within(nav()).findByRole("link", { name: "Claude, not signed in" })).toBeTruthy();
    for (const name of [
      "Overview, can't reach the control panel",
      "Host tools, gh and opengrep required but not found",
      "Version, the last update failed",
      "Storage, low disk",
    ]) {
      const link = within(nav()).getByRole("link", { name });
      expect(link.querySelector(".or-dot--fail")).toBeTruthy();
    }
    for (const name of ["Logs", "Capacity", "Packages"]) {
      expect(within(nav()).getByRole("link", { name }).querySelector(".or-dot")).toBeNull();
    }
  });

  it("has no dots when nothing is wrong, and none for a problem of another section", async () => {
    const other = [{ section: "capacity", reason: "too busy" }] as unknown as NavProblem[];
    const api = fakeApi({ "/api/state": { body: agentState({ problems: other }) } });
    renderAgentPage();
    await screen.findByText("build-01");
    expect(api.count("GET /api/state")).toBeGreaterThan(0);
    expect(nav().querySelectorAll(".or-dot")).toHaveLength(0);
    expect(within(nav()).getByRole("link", { name: "Capacity" })).toBeTruthy();
  });
});
