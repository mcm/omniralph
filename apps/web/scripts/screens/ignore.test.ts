import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  colorsIn,
  detectIgnoredBy,
  ignoredBy,
  parseIgnoreList,
  type FindingCapture,
} from "./ignore";

const LIST = `
| Rule | Scope | Reason | Round |
|---|---|---|---|
| broken-image | \`apps/web/src/lib/review/sanitize.test.ts\` | A test fixture. | TOOL-401 round 1 |
| decided: no-live-indicator | 2.0 code: \`apps/web/src\` | The whole UI is live. | TOOL-730 |
| axe: color-contrast | \`route: settings-*\`, \`theme: light\`, \`target: .or-legend\` | Decorative. | TOOL-748 round 1 |
| \`keyboard: unreachable\` | \`route: runs\`, \`route: /runs/**\`, \`viewport: phone\` | Duplicate row link. | TOOL-748 round 1 |
| axe: region | everywhere | No scope. | TOOL-748 round 1 |
| landmarks: no-h1 | \`page: /help\` | Unknown key. | TOOL-748 round 1 |
`;

const settingsLight: FindingCapture = {
  route: "settings-general",
  path: "/settings",
  surface: "panel",
  viewport: "desktop",
  theme: "light",
};

describe("parseIgnoreList", () => {
  const { entries, problems } = parseIgnoreList(LIST);

  it("reads the accessibility entries, with their scopes", () => {
    expect(entries.map(({ check, rule, scope }) => ({ check, rule, scope }))).toEqual([
      {
        check: "axe",
        rule: "color-contrast",
        scope: { route: ["settings-*"], theme: ["light"], target: [".or-legend"] },
      },
      {
        check: "keyboard",
        rule: "unreachable",
        scope: { route: ["runs", "/runs/**"], viewport: ["phone"] },
      },
    ]);
  });

  it("reports entries that can't ignore anything", () => {
    expect(problems).toEqual([
      "axe: region: no scope, so it ignores nothing",
      "landmarks: no-h1: unknown scope `page: /help` (use route, surface, viewport, theme, target)",
    ]);
  });
});

describe("ignoredBy", () => {
  const { entries } = parseIgnoreList(LIST);
  const contrast = { rule: "color-contrast", target: "main .or-legend > span" };

  it("ignores an axe rule within its scope", () => {
    expect(ignoredBy(entries, "axe", contrast, settingsLight)?.rule).toBe("color-contrast");
  });

  it("needs every scope key to match", () => {
    expect(ignoredBy(entries, "axe", contrast, { ...settingsLight, theme: "dark" })).toBeNull();
    expect(ignoredBy(entries, "axe", contrast, { ...settingsLight, route: "inbox" })).toBeNull();
    expect(
      ignoredBy(entries, "axe", { ...contrast, target: ".or-badge" }, settingsLight),
    ).toBeNull();
    // The rule and the check must match too.
    expect(ignoredBy(entries, "axe", { ...contrast, rule: "label" }, settingsLight)).toBeNull();
    expect(ignoredBy(entries, "keyboard", contrast, settingsLight)).toBeNull();
  });

  it("matches any value of a key, and route globs by name or path", () => {
    const unreachable = { rule: "unreachable", target: 'a.or-row__link "FIX-12"' };
    const phone = { ...settingsLight, viewport: "phone", theme: "dark" };
    expect(
      ignoredBy(entries, "keyboard", unreachable, { ...phone, route: "runs", path: "/runs" }),
    ).not.toBeNull();
    expect(
      ignoredBy(entries, "keyboard", unreachable, {
        ...phone,
        route: "run-epic",
        path: "/runs/abc?tab=stories",
      }),
    ).not.toBeNull();
    expect(
      ignoredBy(entries, "keyboard", unreachable, {
        ...phone,
        route: "runs",
        path: "/runs",
        viewport: "rail",
      }),
    ).toBeNull();
  });

  it("never lets a decided entry or an impeccable rule ignore an accessibility finding", () => {
    for (const check of ["axe", "keyboard", "escape", "landmarks"] as const) {
      for (const rule of ["no-live-indicator", "decided: no-live-indicator", "broken-image"]) {
        expect(ignoredBy(entries, check, { rule, target: null }, settingsLight)).toBeNull();
      }
    }
  });

  it("reads the repository's ignore list without problems", () => {
    const markdown = readFileSync(
      join(__dirname, "../../../../.impeccable/critique/ignore.md"),
      "utf8",
    );
    expect(parseIgnoreList(markdown).problems).toEqual([]);
  });
});

const DETECT_LIST = `
| Rule | Scope | Reason | Round |
|---|---|---|---|
| cramped-padding | \`.or-ref\` (\`packages/ui/styles/refs.css\`), \`.or-tabs.or-tabs--sm\` | Fixed height. | TOOL-748 round 1 |
| cream-palette | \`--or-page: #f5f3ee\` (\`packages/ui/styles/tokens.css\`) | The palette. | TOOL-748 round 1 |
| dark-glow | \`--or-glow\` (\`#B294FF\`) | Rule 15. | TOOL-748 round 1 |
| tight-leading | the badges | Names nothing. | TOOL-748 round 1 |
| decided: no-live-indicator | 2.0 code: \`apps/web/src\` | The whole UI is live. | TOOL-730 |
| axe: color-contrast | \`route: settings-*\` | Decorative. | TOOL-748 round 1 |
`;

describe("the impeccable detect entries", () => {
  const { detect, entries, problems } = parseIgnoreList(DETECT_LIST);
  const snapshot = "/repo/apps/web/.screens/t/runs.desktop.dark.html";

  it("reads every detector rule row, apart from decided and accessibility rows", () => {
    expect(
      detect.map(({ rule, selectors, files, properties, colors }) => ({
        rule,
        selectors,
        files,
        properties,
        colors,
      })),
    ).toEqual([
      {
        rule: "cramped-padding",
        selectors: [["or-ref"], ["or-tabs", "or-tabs--sm"]],
        files: ["packages/ui/styles/refs.css"],
        properties: [],
        colors: [],
      },
      {
        rule: "cream-palette",
        selectors: [],
        files: ["packages/ui/styles/tokens.css"],
        properties: ["--or-page"],
        colors: ["#f5f3ee"],
      },
      {
        rule: "dark-glow",
        selectors: [],
        files: [],
        properties: ["--or-glow"],
        colors: ["#b294ff"],
      },
    ]);
    expect(entries.map((entry) => entry.rule)).toEqual(["color-contrast"]);
    expect(problems).toEqual([
      "tight-leading: names no selector, file, custom property or color in backticks",
    ]);
  });

  it("ignores a snapshot finding that names one of its classes", () => {
    const finding = {
      antipattern: "cramped-padding",
      file: snapshot,
      snippet: '<span> "or-ref": children flush against border on top/bottom (no inset)',
    };
    expect(detectIgnoredBy(detect, finding)?.rule).toBe("cramped-padding");
    // A whole class name only, and the same rule only.
    expect(
      detectIgnoredBy(detect, { ...finding, snippet: '<span> "or-ref-list": children flush' }),
    ).toBeNull();
    expect(detectIgnoredBy(detect, { ...finding, antipattern: "tight-leading" })).toBeNull();
    // A selector of several classes needs all of them.
    expect(detectIgnoredBy(detect, { ...finding, snippet: '<div> "or-tabs": flush' })).toBeNull();
    expect(
      detectIgnoredBy(detect, { ...finding, snippet: '<div> "or-tabs or-tabs--sm": flush' }),
    ).not.toBeNull();
  });

  it("ignores a source finding in one of its files", () => {
    const finding = {
      antipattern: "cramped-padding",
      file: "/repo/packages/ui/styles/refs.css",
      snippet: "padding: 0",
    };
    expect(detectIgnoredBy(detect, finding)).not.toBeNull();
    expect(
      detectIgnoredBy(detect, { ...finding, file: "/repo/packages/ui/styles/other-refs.css" }),
    ).toBeNull();
    // A snapshot isn't one of the files.
    expect(detectIgnoredBy(detect, { ...finding, file: snapshot })).toBeNull();
  });

  it("matches colors in hex or rgb form, and custom properties", () => {
    const cream = {
      antipattern: "cream-palette",
      file: snapshot,
      snippet: "cream/beige page background rgb(245, 243, 238)",
    };
    expect(detectIgnoredBy(detect, cream)).not.toBeNull();
    expect(
      detectIgnoredBy(detect, {
        ...cream,
        snippet: "cream/beige page background rgb(250, 245, 230)",
      }),
    ).toBeNull();
    const glow = {
      antipattern: "dark-glow",
      file: snapshot,
      snippet: "Zero-offset box-shadow glow (#b294ff)",
    };
    expect(detectIgnoredBy(detect, glow)).not.toBeNull();
    expect(
      detectIgnoredBy(detect, { ...glow, snippet: "Zero-offset box-shadow glow (#5ee6d0)" }),
    ).toBeNull();
    expect(
      detectIgnoredBy(detect, { ...glow, snippet: "box-shadow: var(--or-glow)" }),
    ).not.toBeNull();
  });

  it("reads colors", () => {
    expect(colorsIn("#FFF and rgba(178, 148, 255, 0.32), #5ec8d8")).toEqual([
      "#ffffff",
      "#5ec8d8",
      "#b294ff",
    ]);
  });

  it("never lets a decided entry ignore a detect finding", () => {
    const finding = {
      antipattern: "no-live-indicator",
      file: "/repo/apps/web/src/x.tsx",
      snippet: "Live",
    };
    expect(detectIgnoredBy(detect, finding)).toBeNull();
  });
});
