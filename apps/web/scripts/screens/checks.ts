import {
  ACCESSIBILITY_CHECKS,
  ignoredBy,
  type AccessibilityCheck,
  type AccessibilityFinding,
  type AccessibilityIgnoreEntry,
} from "./ignore";
import {
  AGO,
  BANNED_HINTS,
  DOCUMENT_REVISION_DATE,
  LIVE_INDICATOR_ALLOWED,
  LIVE_INDICATORS,
  patternSources,
  REFRESH_CONTROL,
} from "../../src/lib/copy/banned-hints";
import type { Surface } from "./options";
import type { ScreenRoute } from "./routes";

/** A row of the capture script's `results.json`. */
export interface CaptureResult {
  route: string;
  path: string;
  /** The control panel, or the agent's local page (its fixture mode). */
  surface: Surface;
  /** Who it was captured as on the panel: `admin`, `member`, or `null` signed out (and on the agent page). */
  as: "admin" | "member" | null;
  viewport: string;
  width: number;
  theme: string;
  status: number | null;
  finalPath: string | null;
  scrollWidth: number | null;
  overflow: boolean;
  /** Visible `kbd` elements (rule 7: keyboard-shortcut indicators only on the Help page). */
  kbdCount: number;
  /** The visible text around each "Ralph" or "harness" on the page (none expected). */
  retiredWording: string[];
  consoleErrors: string[];
  /** Why the page never showed its content (still loading, or its error boundary). */
  notRendered: string | null;
  /** The in-place errors on the page (failed loads), e.g. a code host the fixtures can't reach. */
  loadErrors: string[];
  error: string | null;
  screenshot: string | null;
  html: string | null;
  /** axe-core's WCAG 2.2 A/AA violations, one per element (the full report is `axeFile`). */
  axe: AccessibilityFinding[];
  /** The keyboard walk's findings: unreachable controls, missing focus indicators, a trap. */
  keyboard: AccessibilityFinding[];
  /** How many elements the keyboard walk focused. */
  keyboardStops: number;
  /** The Escape check's findings, or `null` when the route's steps open no overlay. */
  escape: AccessibilityFinding[] | null;
  /** No `main` landmark, more than one, no `h1`, and (at `rail`) unnamed navigation links. */
  landmarks: AccessibilityFinding[];
  /** Accessibility checks that couldn't run, e.g. `axe: <error>`. */
  checkErrors: string[];
  /** `<screen>.axe.json`: axe-core's violations in full. */
  axeFile: string | null;
  /** `<screen>.aria.yml`: the page's ARIA snapshot. */
  ariaFile: string | null;
  // The Decided checks (`decided-page.mjs`, DESIGN.md "Decided — never flag, never undo"); each
  // a list of findings. Missing from captures made before they existed.
  /** Hint text about where things are (rule 3). */
  hintText?: string[];
  /** A "Live" or "Updated" indicator (rules 9 and 22). */
  liveIndicator?: string[];
  /** Detail actions not in a toolbar of icon buttons and a ⋯ menu (rules 5 and 6). */
  detailToolbar?: string[];
  /** Metadata shown on its own instead of as a badge (rules 1 and 2). */
  bareMetadata?: string[];
  /** A list row with a summary, reason or stats line (rule 8). */
  rowSummary?: string[];
  /** A Details disclosure expanded on load at phone width (rule 16). */
  phoneExpanded?: string[];
  /** The organization badge not first under All organizations, or shown for one (rule 13). */
  orgFirst?: string[];
}

/**
 * The capture checks that guard the Decided items, as `results.json` names them: `kbdCount`
 * (TOOL-734) and those of `decided-page.mjs`. `verify.ts` reports each in its "Decided"
 * section; DESIGN.md's Decided items name them as their guards.
 */
export const DECIDED_CHECKS = [
  "kbdCount",
  "hintText",
  "liveIndicator",
  "detailToolbar",
  "bareMetadata",
  "rowSummary",
  "phoneExpanded",
  "orgFirst",
] as const;
export type DecidedCheck = (typeof DECIDED_CHECKS)[number];

/** What each Decided check looks for, as `verify.ts` titles it. */
export const DECIDED_CHECK_TITLES: Record<DecidedCheck, string> = {
  kbdCount: "Keyboard-shortcut indicators outside the panel's Help page (rule 7)",
  hintText: "Hint text about where things are (rule 3)",
  liveIndicator: 'A "Live" or "Updated" indicator (rules 9 and 22)',
  detailToolbar: "Detail actions: icon buttons with tooltips and a ⋯ menu (rules 5 and 6)",
  bareMetadata: "Metadata shown on its own, not as a badge (rules 1 and 2)",
  rowSummary: "A list row with more than its kind and state, title and badges (rule 8)",
  phoneExpanded: "A Details disclosure expanded on load at phone width (rule 16)",
  orgFirst: "The organization badge first under All organizations, none for one (rule 13)",
};

/** A finding of a Decided check. */
export interface DecidedFinding {
  check: DecidedCheck;
  finding: string;
}

/** Every Decided finding of a capture. */
export function decidedFindings(
  result: CaptureResult,
  route: Pick<ScreenRoute, "page"> | undefined,
): DecidedFinding[] {
  return DECIDED_CHECKS.flatMap((check): DecidedFinding[] => {
    if (check === "kbdCount") {
      return showsShortcutIndicators(result, route)
        ? [{ check, finding: `${result.kbdCount} visible kbd` }]
        : [];
    }
    return (result[check] ?? []).map((finding) => ({ check, finding }));
  });
}

/** The route fields the Decided checks read (the agent page's routes have some of them). */
export type DecidedRoute = Partial<Pick<ScreenRoute, "detail" | "needsYou" | "list" | "as">> & {
  surface?: Surface;
};

/**
 * The options of `decidedInPage` for a route: the banned copy (`src/lib/copy/banned-hints.ts`),
 * the fixture's metadata names, and what the route is (a list, a detail, a needs-you decision,
 * its organization scope: `"all"`, `"single"`, or `null` where there is none).
 */
export function decidedOptions(
  route: DecidedRoute,
  { names, org }: { names: readonly string[]; org: "all" | "single" | null },
) {
  return {
    hints: patternSources(BANNED_HINTS),
    indicators: patternSources(LIVE_INDICATORS),
    indicatorAllowed: [
      ...LIVE_INDICATOR_ALLOWED,
      [DOCUMENT_REVISION_DATE.source, DOCUMENT_REVISION_DATE.flags] as [string, string],
    ],
    ago: [AGO.source, AGO.flags] as [string, string],
    refresh: [REFRESH_CONTROL.source, REFRESH_CONTROL.flags] as [string, string],
    names: [...names],
    detail: route.detail === true,
    needsYou: route.needsYou === true,
    // The member's read-only view of a detail may have no actions at all.
    requireToolbar: route.as !== "member",
    // The agent page's detail (an attempt) has one action and nothing for a ⋯ menu.
    requireMenu: route.surface !== "agent",
    rows: route.list === true || route.detail === true,
    org,
  };
}

/** A finding of an accessibility check, with the check that found it. */
export type CheckedFinding = AccessibilityFinding & { check: AccessibilityCheck };

/** Every accessibility finding of a capture, by check. */
export function accessibilityFindings(result: CaptureResult): CheckedFinding[] {
  return ACCESSIBILITY_CHECKS.flatMap((check) =>
    (result[check] ?? []).map((finding) => ({ ...finding, check })),
  );
}

/** The capture's accessibility findings that no ignore.md entry matches. */
export function unignoredFindings(
  result: CaptureResult,
  ignore: readonly AccessibilityIgnoreEntry[],
): CheckedFinding[] {
  return accessibilityFindings(result).filter(
    (finding) => ignoredBy(ignore, finding.check, finding, result) === null,
  );
}

/** The page whose `kbd`s are allowed: the panel's Help lists every keyboard shortcut (the agent page has none). */
export const HELP_PAGE = "(app)/help/page.tsx";

/** Whether a capture shows keyboard-shortcut indicators where none may be (rule 7). */
export function showsShortcutIndicators(
  result: Pick<CaptureResult, "kbdCount" | "surface">,
  route: Pick<ScreenRoute, "page"> | undefined,
): boolean {
  return result.kbdCount > 0 && !(result.surface === "panel" && route?.page === HELP_PAGE);
}

/**
 * Why a capture fails the run; empty when it passes. `--strict` also fails on overflow, on
 * every Decided finding, and on every accessibility finding that no entry of `ignore`
 * (ignore.md) matches.
 */
export function captureFailures(
  result: CaptureResult,
  route: Pick<ScreenRoute, "page"> | undefined,
  { strict, ignore = [] }: { strict: boolean; ignore?: readonly AccessibilityIgnoreEntry[] },
): string[] {
  const failures: string[] = [];
  if (result.error) failures.push(`failed: ${result.error}`);
  for (const error of result.checkErrors) failures.push(`check failed: ${error}`);
  if (result.notRendered) failures.push(`not rendered: ${result.notRendered}`);
  if (showsShortcutIndicators(result, route)) {
    failures.push(`shows ${result.kbdCount} keyboard-shortcut indicator(s) (rule 7)`);
  }
  if (strict) {
    for (const { check, finding } of decidedFindings(result, route)) {
      if (check !== "kbdCount") failures.push(`decided ${check}: ${finding}`);
    }
  }
  for (const text of result.retiredWording) failures.push(`retired wording: …${text}…`);
  if (strict && result.overflow) {
    failures.push(`wider than the viewport: ${result.scrollWidth}px > ${result.width}px`);
  }
  if (strict) {
    for (const finding of unignoredFindings(result, ignore)) {
      failures.push(
        `${finding.check}: ${finding.rule}${finding.target ? ` ${finding.target}` : ""}: ${finding.summary}`,
      );
    }
  }
  return failures;
}
