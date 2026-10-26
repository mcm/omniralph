import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "layout.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The body of the at-rule whose prelude is `prelude` (balanced braces). */
function atRule(source: string, prelude: string): string {
  const start = source.indexOf(prelude);
  expect(start, prelude).toBeGreaterThanOrEqual(0);
  const open = source.indexOf("{", start);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  throw new Error(`unbalanced ${prelude}`);
}

/** Removes every at-rule block, leaving the top-level rules. */
function topLevel(source: string): string {
  let out = source;
  for (const prelude of ["@media (min-width: 1200px)", "@container or-split (min-width: 880px)"]) {
    const body = atRule(out, prelude);
    const start = out.indexOf(prelude);
    out = out.slice(0, start) + out.slice(out.indexOf(body, start) + body.length + 1);
  }
  return out;
}

function declarations(source: string, selector: string): Record<string, string> {
  const rule = Array.from(source.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
    selectors!.split(",").some((part) => part.trim() === selector),
  );
  return Object.fromEntries(
    (rule?.[2] ?? "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  );
}

const base = topLevel(css);
const wide = atRule(css, "@container or-split (min-width: 880px)");

describe("layout.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/layout\.css"/,
    );
  });

  it("makes the split view an inline-size container", () => {
    expect(declarations(base, ".or-split").container).toBe("or-split / inline-size");
  });

  it("sizes the fixed pane from the listWidth custom properties: wide from 1200 px", () => {
    expect(declarations(base, ".or-split")["--or-split-size"]).toBe("var(--or-split-narrow)");
    expect(declarations(atRule(css, "@media (min-width: 1200px)"), ".or-split")).toEqual({
      "--or-split-size": "var(--or-split-wide)",
    });
  });

  it("shows one pane below 880 px, the one data-view names, with the back link", () => {
    expect(declarations(base, ".or-split__panes")["grid-template-columns"]).toBe("minmax(0, 1fr)");
    expect(declarations(base, '.or-split[data-view="list"] .or-split__detail').display).toBe(
      "none",
    );
    expect(declarations(base, '.or-split[data-view="detail"] .or-split__list').display).toBe(
      "none",
    );
    expect(declarations(base, ".or-split__back").display).toBe("inline-flex");
  });

  it("shows both panes from a container width of 880 px, and hides the back link", () => {
    expect(declarations(wide, ".or-split__panes")["grid-template-columns"]).toBe(
      "var(--or-split-size) minmax(0, 1fr)",
    );
    expect(declarations(wide, ".or-split[data-view] .or-split__list").display).toBe("flex");
    expect(declarations(wide, ".or-split[data-view] .or-split__detail").display).toBe("flex");
    expect(declarations(wide, ".or-split__back").display).toBe("none");
  });

  it('gives the fixed width to the detail with fixedPane: "detail"', () => {
    expect(
      declarations(wide, '.or-split[data-fixed="detail"] .or-split__panes')[
        "grid-template-columns"
      ],
    ).toBe("minmax(0, 1fr) var(--or-split-size)");
  });

  it("fills the active section nav entry like the shell's and pushes the dot to the end", () => {
    expect(declarations(base, '.or-subnav__item[aria-current="page"]')).toEqual({
      background: "var(--or-sel)",
      color: "var(--or-text)",
    });
    expect(declarations(base, ".or-subnav__list")["list-style"]).toBe("none");
    expect(declarations(base, ".or-subnav__dot")["margin-left"]).toBe("auto");
  });

  it("uses only --or- tokens for colors", () => {
    for (const [, value] of css.matchAll(/var\((--[a-z0-9-]+)/g)) {
      expect(value).toMatch(/^--or-/);
    }
  });
});
