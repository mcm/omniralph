import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (name: string) => readFileSync(path.join(__dirname, name), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const fleetCss = strip(read("fleet.css"));
const uiStyles = path.dirname(createRequire(import.meta.url).resolve("@omniralph/ui/styles.css"));
const listsCss = strip(readFileSync(path.join(uiStyles, "lists.css"), "utf8"));

/** The bodies of every `@media (max-width: 768px)` block of `css`, joined. */
function phoneRules(css: string): string {
  const bodies: string[] = [];
  for (const match of css.matchAll(/@media\s*\(max-width:\s*768px\)\s*\{/g)) {
    let depth = 0;
    const open = match.index! + match[0].length - 1;
    for (let index = open; index < css.length; index += 1) {
      if (css[index] === "{") depth += 1;
      if (css[index] === "}") depth -= 1;
      if (depth === 0) {
        bodies.push(css.slice(open + 1, index));
        break;
      }
    }
  }
  expect(bodies.length).toBeGreaterThan(0);
  return bodies.join("\n");
}

/** The sheet without its `@media` blocks. */
function topLevel(css: string): string {
  let out = css;
  for (;;) {
    const start = out.search(/@media[^{]*\{/);
    if (start < 0) return out;
    let depth = 0;
    let index = out.indexOf("{", start);
    for (; index < out.length; index += 1) {
      if (out[index] === "{") depth += 1;
      if (out[index] === "}") depth -= 1;
      if (depth === 0) break;
    }
    out = out.slice(0, start) + out.slice(index + 1);
  }
}

/** The declarations of `selector`'s rule in `css`. */
function declarations(css: string, selector: string): string | undefined {
  const escaped = selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?:^|[}\\s])${escaped}\\s*\\{([^}]*)\\}`).exec(css)?.[1];
}

describe("Fleet's stylesheet", () => {
  it("is imported by the view, whose table is DataTable", () => {
    const view = read("fleet-view.tsx");
    expect(view).toMatch(/import\s+"\.\/fleet\.css";/);
    expect(view).toMatch(/<DataTable\b/);
  });

  it("uses no color literals, only --or- tokens and or- classes", () => {
    expect(fleetCss.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi)).toBeNull();
    const tokens = Array.from(fleetCss.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
    const classes = Array.from(fleetCss.matchAll(/\.([a-z][\w-]*)/gi), ([, name]) => name!);
    expect(classes.filter((name) => !name.startsWith("or-"))).toEqual([]);
  });

  it("shows the table and hides the cards above 768 px", () => {
    const wide = topLevel(listsCss);
    expect(declarations(wide, ".or-cards")).toMatch(/display:\s*none;/);
    expect(declarations(wide, ".or-tblwrap")).not.toMatch(/display:\s*none;/);
  });

  it("hides the table and shows the cards at 768 px and narrower", () => {
    const phone = phoneRules(listsCss);
    expect(declarations(phone, ".or-tblwrap")).toMatch(/display:\s*none;/);
    expect(declarations(phone, ".or-cards")).toMatch(/display:\s*flex;/);
  });

  it("doesn't override which of the table and cards shows", () => {
    expect(fleetCss).not.toMatch(/\.or-(tblwrap|cards)\b/);
  });
});
