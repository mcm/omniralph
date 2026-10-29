import { describe, expect, it } from "vitest";
import { captureFailures, HELP_PAGE, type CaptureResult } from "./checks";
import { parseIgnoreList } from "./ignore";

const clean: CaptureResult = {
  route: "runs",
  path: "/runs",
  surface: "panel",
  as: "admin",
  viewport: "rail",
  width: 1024,
  theme: "dark",
  status: 200,
  finalPath: "/runs",
  scrollWidth: 1024,
  overflow: false,
  kbdCount: 0,
  retiredWording: [],
  consoleErrors: [],
  notRendered: null,
  loadErrors: [],
  error: null,
  screenshot: "runs.rail.dark.png",
  html: "runs.rail.dark.html",
  axe: [],
  keyboard: [],
  keyboardStops: 12,
  escape: null,
  landmarks: [],
  checkErrors: [],
  axeFile: "runs.rail.dark.axe.json",
  ariaFile: "runs.rail.dark.aria.yml",
};
const runsPage = { page: "(app)/runs/page.tsx" };

describe("captureFailures", () => {
  it("passes a clean capture, strict or not", () => {
    expect(captureFailures(clean, runsPage, { strict: false })).toEqual([]);
    expect(captureFailures(clean, runsPage, { strict: true })).toEqual([]);
  });

  it("fails on keyboard-shortcut indicators outside the Help page (rule 7)", () => {
    const withKbd = { ...clean, kbdCount: 2 };
    expect(captureFailures(withKbd, runsPage, { strict: false })).toEqual([
      "shows 2 keyboard-shortcut indicator(s) (rule 7)",
    ]);
    expect(captureFailures(withKbd, { page: HELP_PAGE }, { strict: false })).toEqual([]);
    // The agent page has no Help page: a `kbd` anywhere on it fails.
    expect(
      captureFailures({ ...withKbd, surface: "agent" }, { page: HELP_PAGE }, { strict: false }),
    ).toEqual(["shows 2 keyboard-shortcut indicator(s) (rule 7)"]);
  });

  it("fails on each piece of retired wording", () => {
    const retired = { ...clean, retiredWording: ["the Ralph run", "Ralph said"] };
    expect(captureFailures(retired, runsPage, { strict: false })).toHaveLength(2);
  });

  it("fails on overflow only with --strict", () => {
    const wide = { ...clean, overflow: true, scrollWidth: 1100 };
    expect(captureFailures(wide, runsPage, { strict: false })).toEqual([]);
    expect(captureFailures(wide, runsPage, { strict: true })).toEqual([
      "wider than the viewport: 1100px > 1024px",
    ]);
  });

  it("fails on failed and unrendered captures", () => {
    expect(
      captureFailures({ ...clean, error: "timeout", notRendered: "still loading" }, runsPage, {
        strict: false,
      }),
    ).toHaveLength(2);
  });

  it("fails on accessibility findings only with --strict, unless ignore.md ignores them", () => {
    const contrast = {
      rule: "color-contrast",
      impact: "serious",
      target: ".or-legend",
      summary: "Element has insufficient color contrast of 3.1",
    };
    const withFindings: CaptureResult = {
      ...clean,
      axe: [contrast, { ...contrast, rule: "label", target: "#search" }],
      keyboard: [{ rule: "trap", target: "div.or-pop", summary: "The focus cycles" }],
      escape: [{ rule: "stays-open", target: "div.or-sheet", summary: "Escape doesn't close it" }],
      landmarks: [{ rule: "no-h1", target: null, summary: "The page has no level-1 heading" }],
    };
    expect(captureFailures(withFindings, runsPage, { strict: false })).toEqual([]);
    expect(captureFailures(withFindings, runsPage, { strict: true })).toHaveLength(5);

    const { entries } = parseIgnoreList(`
| Rule | Scope | Reason | Round |
|---|---|---|---|
| axe: color-contrast | \`route: runs\`, \`target: .or-legend\` | Decorative. | TOOL-748 round 1 |
| decided: no-row-status-summaries | 2.0 code: \`apps/web/src\` | Decided. | TOOL-730 |
`);
    expect(captureFailures(withFindings, runsPage, { strict: true, ignore: entries })).toEqual([
      "axe: label #search: Element has insufficient color contrast of 3.1",
      "keyboard: trap div.or-pop: The focus cycles",
      "escape: stays-open div.or-sheet: Escape doesn't close it",
      "landmarks: no-h1: The page has no level-1 heading",
    ]);
  });

  it("fails on an accessibility check that couldn't run", () => {
    expect(
      captureFailures({ ...clean, checkErrors: ["axe: boom"] }, runsPage, { strict: false }),
    ).toEqual(["check failed: axe: boom"]);
  });
});
