import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen, within } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { InfoPopover } from "./popovers.js";
import { SummaryCells, type SummaryCell } from "./summary-cells.js";

const cells: SummaryCell[] = [
  {
    id: "health",
    label: "Health",
    value: "6 of 7 online · 1 offline",
    detail: "1 busy",
  },
  {
    id: "version",
    label: "Version policy",
    value: "Track latest",
    detail: <a href="/fleet?edit=version">Edit</a>,
    info: <InfoPopover label="About the version policy">Last changed by Ada</InfoPopover>,
  },
  { id: "defaults", label: "Org defaults", value: "Accept all kinds" },
];

describe("SummaryCells", () => {
  it("renders one card with a group per cell, named by its label", () => {
    const { container } = render(<SummaryCells cells={cells} />);
    expect(container.querySelectorAll(".or-card")).toHaveLength(1);
    const card = container.querySelector(".or-card")!;
    expect(card.classList.contains("or-stats")).toBe(true);
    const groups = screen.getAllByRole("group");
    expect(groups.map((group) => group.getAttribute("aria-labelledby") !== null)).toEqual([
      true,
      true,
      true,
    ]);
    expect(screen.getByRole("group", { name: "Health" })).toBe(groups[0]);
    expect(screen.getByRole("group", { name: "Version policy" })).toBe(groups[1]);
    expect(screen.getByRole("group", { name: "Org defaults" })).toBe(groups[2]);
    for (const group of groups) expect(card.contains(group)).toBe(true);
  });

  it("shows each value and detail, and no detail line when none is given", () => {
    render(<SummaryCells cells={cells} />);
    const health = screen.getByRole("group", { name: "Health" });
    expect(health.querySelector(".or-stats__value")!.textContent).toBe("6 of 7 online · 1 offline");
    expect(health.querySelector(".or-stats__detail")!.textContent).toBe("1 busy");
    const version = screen.getByRole("group", { name: "Version policy" });
    expect(within(version).getByRole("link", { name: "Edit" }).getAttribute("href")).toBe(
      "/fleet?edit=version",
    );
    const defaults = screen.getByRole("group", { name: "Org defaults" });
    expect(within(defaults).getByText("Accept all kinds")).toBeTruthy();
    expect(defaults.querySelector(".or-stats__detail")).toBeNull();
  });

  it("renders the info slot right after the label", async () => {
    const user = userEvent.setup();
    render(<SummaryCells cells={cells} />);
    const version = screen.getByRole("group", { name: "Version policy" });
    const label = within(version).getByText("Version policy");
    const button = within(version).getByRole("button", { name: "About the version policy" });
    expect(label.nextElementSibling).toBe(button);
    await user.click(button);
    expect((await screen.findByRole("dialog")).textContent).toContain("Last changed by Ada");
    // Cells without info have nothing after the label.
    const health = screen.getByRole("group", { name: "Health" });
    expect(within(health).getByText("Health").nextElementSibling).toBeNull();
  });

  it("names the card as a region when aria-label is given", () => {
    const { rerender } = render(<SummaryCells cells={cells} />);
    expect(screen.queryByRole("region")).toBeNull();
    rerender(<SummaryCells cells={cells} aria-label="Summary" />);
    expect(screen.getByRole("region", { name: "Summary" })).toBeTruthy();
  });

  it("renders no keyboard-shortcut text", () => {
    const { container } = render(<SummaryCells cells={cells} />);
    expect(container.querySelector("kbd")).toBeNull();
    expect(container.textContent).not.toMatch(/⌘|Ctrl\+|Alt\+|Shift\+/);
  });
});

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "surfaces.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function rules(source: string): [string[], Record<string, string>][] {
  return Array.from(source.matchAll(/([^{}]+)\{([^{}]*)\}/g)).map(([, selectors, body]) => [
    selectors!.split(",").map((part) => part.trim()),
    Object.fromEntries(
      body!
        .split(";")
        .map((declaration) => declaration.trim())
        .filter(Boolean)
        .map((declaration) => {
          const colon = declaration.indexOf(":");
          return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
        }),
    ),
  ]);
}

function declarations(source: string, selector: string): Record<string, string> {
  return rules(source).find(([selectors]) => selectors.includes(selector))?.[1] ?? {};
}

/** The bodies of every `@media (max-width: 768px)` block (balanced braces). */
function phoneBlocks(source: string): string {
  const prelude = "@media (max-width: 768px)";
  let out = "";
  let from = 0;
  for (;;) {
    const start = source.indexOf(prelude, from);
    if (start < 0) return out;
    const open = source.indexOf("{", start);
    let depth = 0;
    let i = open;
    for (; i < source.length; i++) {
      if (source[i] === "{") depth++;
      if (source[i] === "}" && --depth === 0) break;
    }
    out += source.slice(open + 1, i);
    from = i;
  }
}

describe("summary cells CSS", () => {
  const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");

  it("lays the cells side by side in one row", () => {
    expect(declarations(topLevel, ".or-stats")).toMatchObject({
      display: "grid",
      "grid-auto-flow": "column",
      "grid-auto-columns": "minmax(0, 1fr)",
    });
  });

  it("wraps to two columns at 768 px and narrower", () => {
    expect(declarations(phoneBlocks(css), ".or-stats")).toEqual({
      "grid-auto-flow": "row",
      "grid-template-columns": "repeat(2, minmax(0, 1fr))",
    });
  });

  it("uses only --or- tokens", () => {
    const stats = rules(css)
      .filter(([selectors]) => selectors.some((selector) => selector.startsWith(".or-stats")))
      .flatMap(([, body]) => Object.values(body));
    expect(stats.length).toBeGreaterThan(0);
    for (const value of stats) {
      expect(value).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|oklch)\(/i);
      for (const [, name] of value.matchAll(/var\((--[a-z0-9-]+)/g)) expect(name).toMatch(/^--or-/);
    }
  });
});
