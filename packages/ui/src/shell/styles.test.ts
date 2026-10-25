import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "shell.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const MEDIA = /@media([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g;
const topLevel = css.replace(MEDIA, "");

type Rules = { selectors: string[]; declarations: Record<string, string> }[];

function parseRules(source: string): Rules {
  return Array.from(source.matchAll(/([^{}]+)\{([^}]*)\}/g)).map(([, selectors, body]) => ({
    selectors: selectors!.split(",").map((part) => part.trim()),
    declarations: Object.fromEntries(
      body!
        .split(";")
        .map((declaration) => declaration.trim())
        .filter(Boolean)
        .map((declaration) => {
          const colon = declaration.indexOf(":");
          return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
        }),
    ),
  }));
}

function media(query: string): Rules {
  const block = Array.from(css.matchAll(MEDIA)).find(
    ([, condition]) => condition!.trim() === query,
  );
  expect(block, `@media ${query}`).toBeDefined();
  return parseRules(block![2]!);
}

function declarations(rules: Rules, selector: string): Record<string, string> {
  return Object.assign(
    {},
    ...rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.declarations),
  );
}

const RAIL = "(min-width: 769px) and (max-width: 1199px)";
const PHONE = "(max-width: 768px)";

describe("shell.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/shell\.css"/,
    );
  });

  it("draws the 232 px sidebar by default, with the top bar and tab bar hidden", () => {
    const rules = parseRules(topLevel);
    expect(declarations(rules, ".or-sidebar").width).toBe("var(--or-side-w)");
    expect(declarations(rules, ".or-topbar").display).toBe("none");
    expect(declarations(rules, ".or-topbar").height).toBe("52px");
    expect(declarations(rules, ".or-tabbar").display).toBe("none");
    expect(declarations(rules, ".or-drawer").width).toContain("300px");
    expect(declarations(rules, ".or-nav__item--drawer").height).toBe("44px");
  });

  it("draws counts as the accent pill", () => {
    const count = declarations(parseRules(topLevel), ".or-nav__count");
    expect(count.background).toBe("var(--or-acc)");
    expect(count.color).toBe("var(--or-acc-ink)");
  });

  describe("icon rail", () => {
    const rail = media(RAIL);

    it("sets the sidebar to 64 px", () => {
      expect(declarations(rail, ".or-sidebar").width).toBe("var(--or-rail-w)");
      expect(declarations(rail, ".or-frame")["grid-template-columns"]).toMatch(
        /^var\(--or-rail-w\)/,
      );
    });

    it("hides labels, the wordmark, the picker label and the footer name with clip", () => {
      for (const selector of [".or-sidebar .or-rail-hidden", ".or-sidebar .or-wordmark"]) {
        const hidden = declarations(rail, selector);
        expect(hidden.position).toBe("absolute");
        expect(hidden.width).toBe("1px");
        expect(hidden.height).toBe("1px");
        expect(hidden.overflow).toBe("hidden");
        expect(hidden.clip).toBe("rect(0 0 0 0)");
        expect(hidden["clip-path"]).toBe("inset(50%)");
      }
    });

    it("never uses display: none or visibility: hidden", () => {
      for (const rule of rail) {
        expect(rule.declarations.display, rule.selectors.join(", ")).not.toBe("none");
        expect(rule.declarations.visibility, rule.selectors.join(", ")).not.toBe("hidden");
      }
    });

    it("moves the count and the pip to the icon's corner", () => {
      for (const selector of [".or-sidebar .or-nav__count", ".or-sidebar .or-nav__pip"]) {
        const indicator = declarations(rail, selector);
        expect(indicator.position).toBe("absolute");
        expect(indicator.top).toBeDefined();
        expect(indicator.right).toBeDefined();
      }
    });

    it("shows the rail tooltips only on the rail", () => {
      const elsewhere = media("(min-width: 1200px), (max-width: 768px)");
      expect(declarations(elsewhere, ".or-tip--rail").display).toBe("none");
    });
  });

  describe("phone", () => {
    const phone = media(PHONE);

    it("hides the sidebar and shows the top bar and tab bar", () => {
      expect(declarations(phone, ".or-sidebar").display).toBe("none");
      expect(declarations(phone, ".or-topbar").display).toBe("flex");
      expect(declarations(phone, ".or-tabbar").display).toBe("block");
    });

    it("keeps the page clear of the tab bar", () => {
      expect(
        declarations(phone, ".or-frame--tabs .or-frame__main")["padding-bottom"],
      ).toBeDefined();
    });
  });
});
