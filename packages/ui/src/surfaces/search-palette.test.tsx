import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { IssueBadge } from "../refs/badges.js";
import { SearchPalette, type SearchPaletteGroup } from "./search-palette.js";

const GROUPS: SearchPaletteGroup[] = [
  {
    id: "runs",
    label: "Runs",
    items: [
      {
        id: "run-1",
        title: "Fix the login",
        kindLabel: "Epic · running",
        tone: "run",
        meta: <IssueBadge tracker="linear" id="SOC-1719" />,
      },
      { id: "run-2", title: "Tidy the docs", kindLabel: "Request · finished", tone: "good" },
    ],
  },
  { id: "empty", label: "Agents", items: [] },
  {
    id: "repos",
    label: "Repos",
    items: [{ id: "repo-1", title: "acme/web", mark: <span>GL</span> }],
  },
];

function Palette({
  groups = GROUPS,
  onSelect = () => {},
  message,
}: {
  groups?: SearchPaletteGroup[];
  onSelect?: (id: string) => void;
  message?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Search
      </button>
      <SearchPalette
        open={open}
        onOpenChange={setOpen}
        query={query}
        onQueryChange={setQuery}
        groups={groups}
        onSelect={(item) => onSelect(item.id)}
        message={message}
      />
    </>
  );
}

async function openPalette(props: Parameters<typeof Palette>[0] = {}) {
  const user = userEvent.setup();
  render(<Palette {...props} />);
  await user.click(screen.getByRole("button", { name: "Search" }));
  return { user, dialog: screen.getByRole("dialog", { name: "Search or jump to…" }) };
}

describe("SearchPalette", () => {
  it("opens a dialog with focus in its combobox, the results grouped in a listbox", async () => {
    const { dialog } = await openPalette();
    const input = within(dialog).getByRole("combobox", { name: "Search or jump to…" });
    expect(document.activeElement).toBe(input);
    expect(input.getAttribute("placeholder")).toBe("Search or jump to…");
    const listbox = within(dialog).getByRole("listbox");
    expect(input.getAttribute("aria-controls")).toBe(listbox.id);
    expect(input.getAttribute("aria-expanded")).toBe("true");
    const groups = within(listbox).getAllByRole("group");
    // The group without items is left out.
    expect(groups.map((group) => group.getAttribute("aria-labelledby"))).toHaveLength(2);
    expect(within(listbox).getByRole("group", { name: "Runs" })).toBeTruthy();
    expect(within(listbox).getByRole("group", { name: "Repos" })).toBeTruthy();
    expect(within(listbox).getAllByRole("option")).toHaveLength(3);
    // The badges are in the row.
    expect(within(listbox).getByText("SOC-1719")).toBeTruthy();
    // No keyboard hints anywhere (Design rule 7).
    expect(dialog.textContent).not.toMatch(/⌘|Ctrl|↵|Esc/);
  });

  it("moves the highlighted result with the arrow keys, announced via aria-activedescendant", async () => {
    const { user, dialog } = await openPalette();
    const input = within(dialog).getByRole("combobox");
    const options = within(dialog).getAllByRole("option");
    const active = () => input.getAttribute("aria-activedescendant");
    expect(active()).toBe(options[0]!.id);
    expect(options[0]!.getAttribute("aria-selected")).toBe("true");
    await user.keyboard("{ArrowDown}");
    expect(active()).toBe(options[1]!.id);
    expect(options[1]!.getAttribute("aria-selected")).toBe("true");
    expect(options[0]!.getAttribute("aria-selected")).toBe("false");
    await user.keyboard("{ArrowDown}{ArrowDown}");
    // It wraps around.
    expect(active()).toBe(options[0]!.id);
    await user.keyboard("{ArrowUp}");
    expect(active()).toBe(options[2]!.id);
    expect(document.activeElement).toBe(input);
  });

  it("chooses the highlighted result with Enter, and any result with a click", async () => {
    const onSelect = vi.fn();
    const { user, dialog } = await openPalette({ onSelect });
    await user.keyboard("{ArrowDown}{Enter}");
    expect(onSelect).toHaveBeenLastCalledWith("run-2");
    await user.click(within(dialog).getByRole("option", { name: /acme\/web/ }));
    expect(onSelect).toHaveBeenLastCalledWith("repo-1");
  });

  it("closes on Escape without choosing, and focus returns to the opener", async () => {
    const onSelect = vi.fn();
    const { user } = await openPalette({ onSelect });
    await user.type(screen.getByRole("combobox"), "soc");
    await user.keyboard("{Escape}");
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onSelect).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Search" }));
  });

  it("shows and announces the message while there are no results", async () => {
    const { user, dialog } = await openPalette({ groups: [], message: "No matches for “zz”" });
    const input = within(dialog).getByRole("combobox");
    expect(input.getAttribute("aria-expanded")).toBe("false");
    expect(input.hasAttribute("aria-activedescendant")).toBe(false);
    expect(within(dialog).getByRole("status").textContent).toBe("No matches for “zz”");
    expect(within(dialog).queryAllByRole("option")).toHaveLength(0);
    // Enter with nothing to choose does nothing.
    await user.keyboard("{Enter}{ArrowDown}");
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("highlights the first result again when the results change", async () => {
    function Changing() {
      const [query, setQuery] = useState("");
      const groups: SearchPaletteGroup[] = [
        {
          id: "g",
          label: "Runs",
          items: (query ? ["c", "d"] : ["a", "b"]).map((id) => ({
            id,
            title: id,
            kindLabel: "Epic · running",
            tone: "run" as const,
          })),
        },
      ];
      return (
        <SearchPalette
          open
          onOpenChange={() => {}}
          query={query}
          onQueryChange={setQuery}
          groups={groups}
          onSelect={() => {}}
        />
      );
    }
    const user = userEvent.setup();
    render(<Changing />);
    const input = screen.getByRole("combobox");
    await user.keyboard("{ArrowDown}");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[1]!.id);
    await user.type(input, "x");
    expect(input.getAttribute("aria-activedescendant")).toBe(screen.getAllByRole("option")[0]!.id);
  });
});

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "surfaces.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("search palette styles", () => {
  it("is centered on wider screens and full screen on a phone", () => {
    expect(css).toMatch(/\.or-palette \{[^}]*left: 50%;[^}]*transform: translateX\(-50%\);/);
    const phone = css.slice(css.lastIndexOf("@media (max-width: 768px)"));
    expect(phone).toMatch(
      /\.or-palette \{[^}]*top: 0;[^}]*left: 0;[^}]*width: 100%;[^}]*height: 100%;/,
    );
    // The close button only shows full screen.
    expect(css).toMatch(/\.or-palette__close \{\s*display: none;/);
    expect(phone).toMatch(/\.or-palette__close \{\s*display: inline-flex;/);
  });
});
