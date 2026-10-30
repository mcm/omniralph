import { readdirSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Layout facts jsdom can't compute, read from the stylesheets: the chart grid, the phone
 * rules (at 768 px and narrower) and the chart heights.
 */
const read = (name: string) => readFileSync(path.join(__dirname, name), "utf8");
const strip = (css: string) => css.replace(/\/\*[\s\S]*?\*\//g, "");
const pageCss = strip(read("analytics.css"));
const uiStyles = path.dirname(createRequire(import.meta.url).resolve("@omniralph/ui/styles.css"));
const chartsCss = strip(readFileSync(path.join(uiStyles, "charts.css"), "utf8"));
const listsCss = strip(readFileSync(path.join(uiStyles, "lists.css"), "utf8"));
const surfacesCss = strip(readFileSync(path.join(uiStyles, "surfaces.css"), "utf8"));

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

/** The declarations of `selector`'s rule in `css` (a selector list counts each part). */
function declarations(css: string, selector: string): Record<string, string> {
  const rule = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
    selectors!.split(",").some((part) => part.trim() === selector),
  );
  expect(rule, selector).toBeDefined();
  return Object.fromEntries(
    rule![2]!
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  );
}

describe("Analytics' stylesheet", () => {
  it("is imported by the view", () => {
    expect(read("analytics-view.tsx")).toMatch(/import\s+"\.\/analytics\.css";/);
  });

  it("is one column, 24 px padding, at most 1200 px wide", () => {
    const page = declarations(topLevel(pageCss), ".or-analytics");
    expect(page.padding).toBe("24px");
    expect(page["max-width"]).toBe("1200px");
  });

  it("puts the filters on one line beside the title on desktop", () => {
    const top = topLevel(pageCss);
    expect(declarations(top, ".or-analytics__head")).toMatchObject({
      display: "flex",
      "justify-content": "space-between",
    });
    expect(declarations(top, ".or-analytics__filters")).toMatchObject({
      display: "flex",
      "flex-wrap": "nowrap",
    });
  });

  it("lays the charts in a grid of 420 px minimum columns, 16 px apart", () => {
    expect(declarations(topLevel(pageCss), ".or-analytics__charts")).toMatchObject({
      display: "grid",
      "grid-template-columns": "repeat(auto-fit, minmax(420px, 1fr))",
      gap: "16px",
    });
  });

  it("wraps the head row on phone: the title alone, then each filter at full width", () => {
    const phone = phoneRules(pageCss);
    expect(declarations(phone, ".or-analytics__head")["flex-direction"]).toBe("column");
    expect(declarations(phone, ".or-analytics__filters")["flex-direction"]).toBe("column");
    expect(declarations(phone, ".or-analytics__window").width).toBe("100%");
    expect(declarations(phone, ".or-analytics__filters .or-select").width).toBe("100%");
  });

  it("makes the charts one column, 140 px tall, naming only the first and last bucket on phone", () => {
    expect(
      declarations(phoneRules(pageCss), ".or-analytics__charts")["grid-template-columns"],
    ).toBe("minmax(0, 1fr)");
    expect(declarations(topLevel(chartsCss), ".or-chart")["--or-chart-height"]).toBe("180px");
    const phoneCharts = phoneRules(chartsCss);
    expect(declarations(phoneCharts, ".or-chart")["--or-chart-height"]).toBe("140px");
    expect(declarations(phoneCharts, ".or-chart__label--middle").display).toBe("none");
  });

  it("puts By kind in its collapsed section on phone only", () => {
    const top = topLevel(pageCss);
    const phone = phoneRules(pageCss);
    expect(declarations(top, ".or-analytics__by-kind-phone").display).toBe("none");
    expect(declarations(phone, ".or-analytics__by-kind").display).toBe("none");
    expect(declarations(phone, ".or-analytics__by-kind-phone").display).toBe("block");
  });

  it("labels each figure on the phone cards, and keeps the org badge out of the card title", () => {
    expect(declarations(topLevel(pageCss), ".or-analytics__figure-label").display).toBe("none");
    const phone = phoneRules(pageCss);
    expect(declarations(phone, ".or-analytics__figure-label").display).toBe("inline");
    expect(declarations(phone, ".or-cardrow__title .or-analytics__repo-org").display).toBe("none");
  });

  it("relies on DataTable's stacked cards and SummaryCells' two columns on phone", () => {
    const lists = phoneRules(listsCss);
    expect(declarations(lists, ".or-tblwrap").display).toBe("none");
    expect(declarations(lists, ".or-cards").display).toMatch(/flex|block|grid/);
    expect(phoneRules(surfacesCss)).toMatch(
      /\.or-stats\s*\{[^}]*grid-template-columns:\s*repeat\(2,/,
    );
  });

  it("uses only --or- tokens", () => {
    expect(pageCss).not.toMatch(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?)\(/i);
    for (const match of pageCss.matchAll(/var\((--[\w-]+)/g)) expect(match[1]).toMatch(/^--or-/);
  });
});

describe("the Analytics page's files", () => {
  const sources = readdirSync(__dirname)
    .filter((file) => /\.tsx?$/.test(file))
    .map((file) => [file, read(file)] as const);

  it("import no chart library", () => {
    for (const [file, source] of sources) {
      expect(source, file).not.toMatch(
        /["'](recharts|d3[\w-]*|chart\.js|@nivo\/[\w-]+|victory)["']/,
      );
    }
  });
});
