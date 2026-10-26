import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(path.join(__dirname, name), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const sheets = {
  "repos.css": strip(read("repos.css")),
  "repo-detail.css": strip(read("repo-detail.css")),
};
const detailCss = sheets["repo-detail.css"];

/** The body of the first `@media (max-width: 768px)` block (the phone rules). */
function phoneRules(css: string): string {
  const start = css.search(/@media\s*\(max-width:\s*768px\)\s*\{/);
  expect(start).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}") depth -= 1;
    if (depth === 0) return css.slice(css.indexOf("{", start) + 1, index);
  }
  throw new Error("unclosed @media block");
}

/** The declarations of `selector`'s rule in `css` (outside any @media when `css` is the sheet). */
function declarations(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

describe("the Repos screen's stylesheets", () => {
  it("are imported by their views", () => {
    expect(read("repos-view.tsx")).toMatch(/import\s+"\.\/repos\.css";/);
    expect(read("repo-detail-view.tsx")).toMatch(/import\s+"\.\/repo-detail\.css";/);
  });

  it.each(Object.entries(sheets))("%s uses no color literals", (_name, css) => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi)).toBeNull();
  });

  it.each(Object.entries(sheets))("%s uses only --or- tokens and or- classes", (_name, css) => {
    const tokens = Array.from(css.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
    const classes = Array.from(css.matchAll(/\.([a-z][\w-]*)/gi), ([, name]) => name!);
    expect(classes.filter((name) => !name.startsWith("or-"))).toEqual([]);
  });

  it("leaves the rail's widths to SplitView's defaults", () => {
    for (const css of Object.values(sheets))
      expect(css).not.toMatch(/--or-split-(wide|narrow)\s*:/);
    expect(read("repos-view.tsx")).not.toMatch(/listWidth=/);
  });

  it("dims a rail row's switch icon that is off to 35%", () => {
    expect(declarations(sheets["repos.css"], ".or-repo-row__switch--off")).toMatch(
      /opacity:\s*0\.35;/,
    );
  });

  it("keeps the organization and branch in the header and hides Details above phone width", () => {
    const desktop = detailCss.slice(0, detailCss.search(/@media\s*\(max-width:\s*768px\)/));
    expect(declarations(desktop, ".or-repo-detail__details")).toMatch(/display:\s*none;/);
    expect(declarations(desktop, ".or-repo-detail__context")).not.toMatch(/display:\s*none;/);
  });

  it("moves the organization and branch into the collapsed Details on phone", () => {
    const phone = phoneRules(detailCss);
    expect(declarations(phone, ".or-repo-detail__context")).toMatch(/display:\s*none;/);
    expect(declarations(phone, ".or-repo-detail__details")).toMatch(/display:\s*block;/);
  });
});
