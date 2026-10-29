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

/** Why a capture fails the run; empty when it passes. `--strict` also fails on overflow. */
export function captureFailures(
  result: CaptureResult,
  route: Pick<ScreenRoute, "page"> | undefined,
  strict: boolean,
): string[] {
  const failures: string[] = [];
  if (result.error) failures.push(`failed: ${result.error}`);
  if (result.notRendered) failures.push(`not rendered: ${result.notRendered}`);
  if (showsShortcutIndicators(result, route)) {
    failures.push(`shows ${result.kbdCount} keyboard-shortcut indicator(s) (rule 7)`);
  }
  for (const text of result.retiredWording) failures.push(`retired wording: …${text}…`);
  if (strict && result.overflow) {
    failures.push(`wider than the viewport: ${result.scrollWidth}px > ${result.width}px`);
  }
  return failures;
}
