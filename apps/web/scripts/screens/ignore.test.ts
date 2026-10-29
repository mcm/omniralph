import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ignoredBy, parseIgnoreList, type FindingCapture } from "./ignore";

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

  it("reads the accessibility entries only, with their scopes", () => {
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
