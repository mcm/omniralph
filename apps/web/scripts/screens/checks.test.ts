import { describe, expect, it } from "vitest";
import {
  captureFailures,
  DECIDED_CHECKS,
  decidedFindings,
  decidedOptions,
  HELP_PAGE,
  unignoredDetectFindings,
  type CaptureResult,
} from "./checks";
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
  keyboardStops: [
    { selector: "a.or-skip", name: "Skip to content" },
    { selector: "a.or-nav__link", name: "Inbox" },
  ],
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

  it("fails on impeccable detect findings only with --strict, unless ignore.md ignores them", () => {
    const html = "/repo/apps/web/.screens/t/runs.rail.dark.html";
    const detected: CaptureResult = {
      ...clean,
      impeccable: [
        {
          antipattern: "cramped-padding",
          file: html,
          snippet: '<span> "or-ref": children flush against border on top/bottom (no inset)',
        },
        {
          antipattern: "marquee",
          file: html,
          snippet: '.whiteout::after — infinite horizontal loop animation "whiteout-sheen"',
        },
      ],
    };
    expect(captureFailures(detected, runsPage, { strict: false })).toEqual([]);
    expect(captureFailures(detected, runsPage, { strict: true })).toHaveLength(2);

    const { detect } = parseIgnoreList(`
| Rule | Scope | Reason | Round |
|---|---|---|---|
| cramped-padding | \`.or-ref\` (\`packages/ui/styles/refs.css\`) | Fixed height. | TOOL-748 round 1 |
| decided: no-live-indicator | 2.0 code: \`apps/web/src\` | Decided. | TOOL-730 |
`);
    expect(captureFailures(detected, runsPage, { strict: true, detectIgnore: detect })).toEqual([
      'impeccable: marquee: .whiteout::after — infinite horizontal loop animation "whiteout-sheen"',
    ]);
    expect(
      unignoredDetectFindings({ impeccable: detected.impeccable }, detect).map(
        (finding) => finding.antipattern,
      ),
    ).toEqual(["marquee"]);
    expect(unignoredDetectFindings({}, detect)).toEqual([]);
  });

  it("fails --strict when impeccable detect failed on the snapshot", () => {
    const failed = { ...clean, impeccableError: "unreadable output: not a list of findings" };
    expect(captureFailures(failed, runsPage, { strict: false })).toEqual([]);
    expect(captureFailures(failed, runsPage, { strict: true })).toEqual([
      "impeccable detect failed: unreadable output: not a list of findings",
    ]);
  });

  it("fails on an accessibility check that couldn't run", () => {
    expect(
      captureFailures({ ...clean, checkErrors: ["axe: boom"] }, runsPage, { strict: false }),
    ).toEqual(["check failed: axe: boom"]);
  });
});

describe("the Decided checks", () => {
  const findings = {
    hintText: ['"Finished work is in Runs" in p'],
    liveIndicator: ['"Live" in div'],
    detailToolbar: ['"Run actions": no "More actions" (⋯) menu (rule 5)'],
    bareMetadata: ['"FIX-101" in span'],
    rowSummary: ['"Fix it": "3 of 5 stories" in span.or-row__stats'],
    phoneExpanded: ['"Details" is expanded on load'],
    orgFirst: ['row "Fix it": the first badge is issue "FIX-101", not the organization'],
  };

  it("fails on each Decided finding only with --strict", () => {
    const failing = { ...clean, ...findings };
    expect(captureFailures(failing, runsPage, { strict: false })).toEqual([]);
    expect(captureFailures(failing, runsPage, { strict: true })).toEqual([
      'decided hintText: "Finished work is in Runs" in p',
      'decided liveIndicator: "Live" in div',
      'decided detailToolbar: "Run actions": no "More actions" (⋯) menu (rule 5)',
      'decided bareMetadata: "FIX-101" in span',
      'decided rowSummary: "Fix it": "3 of 5 stories" in span.or-row__stats',
      'decided phoneExpanded: "Details" is expanded on load',
      'decided orgFirst: row "Fix it": the first badge is issue "FIX-101", not the organization',
    ]);
  });

  it("lists the shortcut indicators among them, by check, and reads old results as clean", () => {
    const failing = { ...clean, ...findings, kbdCount: 1 };
    expect(decidedFindings(failing, runsPage).map((finding) => finding.check)).toEqual([
      ...DECIDED_CHECKS,
    ]);
    expect(decidedFindings({ ...failing, kbdCount: 1 }, { page: HELP_PAGE })[0]?.check).toBe(
      "hintText",
    );
    expect(decidedFindings(clean, runsPage)).toEqual([]);
  });

  it("asks for a ⋯ menu on the panel's details, checks rows on lists and details", () => {
    const names = ["build-01"];
    expect(decidedOptions({ detail: true }, { names, org: "single" })).toMatchObject({
      detail: true,
      requireMenu: true,
      rows: true,
      needsYou: false,
      org: "single",
    });
    expect(decidedOptions({ detail: true, surface: "agent" }, { names, org: null })).toMatchObject({
      requireMenu: false,
      org: null,
    });
    expect(decidedOptions({ list: true }, { names, org: "all" })).toMatchObject({
      detail: false,
      rows: true,
    });
    expect(decidedOptions({}, { names, org: "all" }).rows).toBe(false);
  });
});
