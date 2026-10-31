// @vitest-environment jsdom
import { isNavActive, ShortcutProvider, type ShortcutPlatform } from "@omniralph/ui";
import { cleanup, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { navItems } from "@/lib/navigation";
import { SHORTCUTS } from "@/lib/shortcuts";
import { HelpView, SHORTCUTS_INTRO } from "./help-view";

function renderHelp(platform: ShortcutPlatform) {
  return render(
    <ShortcutProvider definitions={SHORTCUTS} platform={platform}>
      <HelpView />
    </ShortcutProvider>,
  );
}

/** Each group's table as [action, key] pairs. */
function tables() {
  return Object.fromEntries(
    screen.getAllByRole("table").map((table) => [
      table.querySelector("caption")?.textContent,
      within(table)
        .getAllByRole("row")
        .slice(1)
        .map((row) => [...row.querySelectorAll("td")].map((cell) => cell.textContent)),
    ]),
  );
}

afterEach(() => {
  cleanup();
});

describe("HelpView", () => {
  it("shows Help, the Keyboard shortcuts card and its intro line", () => {
    renderHelp("other");
    expect(screen.getByRole("heading", { level: 1, name: "Help" })).toBeTruthy();
    const card = screen.getByRole("region", { name: "Keyboard shortcuts" });
    expect(within(card).getByText(SHORTCUTS_INTRO)).toBeTruthy();
  });

  it("lists every action of the registry once, by group in order, with Ctrl off Apple platforms", () => {
    renderHelp("other");
    expect(tables()).toEqual({
      "Go to": [
        ["Go to Inbox", "1"],
        ["Go to Runs", "2"],
        ["Go to Backlog", "3"],
        ["Go to Repos", "4"],
        ["Go to Fleet", "5"],
        ["Go to Analytics", "6"],
        ["Go to Settings", "7"],
        ["Search", "Ctrl+K"],
        ["Open or close Ask", "Ctrl+J"],
        ["Open Help", "?"],
      ],
      Lists: [
        ["Next item", "j"],
        ["Previous item", "k"],
        ["Open the focused item", "o"],
        ["Back to the list", "u"],
      ],
      Inbox: [
        ["Done or dismiss", "e"],
        ["Skip story", "s"],
        ["Snooze", "z"],
        ["Start anyway", "t"],
        ["Resume", "c"],
        ["View PRD", "v"],
        ["Open the PR or MR", "p"],
      ],
      Runs: [
        ["Retry", "r"],
        ["Stop run", "x"],
      ],
      "Work items": [["New work item", "n"]],
      Panels: [["Close", "Esc"]],
    });
    const listed = Object.values(tables()).flat().length;
    expect(listed).toBe(Object.keys(SHORTCUTS).length);
    // Each key is a kbd, in the table and on the phone cards.
    const table = screen.getAllByRole("table")[0]!;
    expect(table.querySelectorAll("kbd").length).toBe(10);
    expect(document.querySelectorAll("kbd").length).toBe(2 * Object.keys(SHORTCUTS).length);
  });

  it("shows Mod as ⌘ on Apple platforms", () => {
    renderHelp("apple");
    const goTo = tables()["Go to"] as string[][];
    expect(goTo).toContainEqual(["Search", "⌘K"]);
    expect(goTo).toContainEqual(["Open or close Ask", "⌘J"]);
  });

  it("is no nav entry's page", () => {
    expect(navItems.filter((item) => isNavActive("/help", item))).toEqual([]);
  });
});
