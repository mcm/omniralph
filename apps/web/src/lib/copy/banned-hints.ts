/**
 * Copy the UI never shows (DESIGN.md, Decided items 4 and 6). Both lists are checked twice: in
 * source by `src/user-facing-wording.test.ts`, and on every screenshot by `verify:screens`
 * (`hintText`, `liveIndicator` in `scripts/screens/decided-page.mjs`).
 */

/** A banned phrase: what it catches, and an example of it. */
export interface BannedPhrase {
  id: string;
  pattern: RegExp;
  /** A phrase it must catch (the list's self-test). */
  example: string;
}

/** The screens a hint would point at. */
const SCREENS = "(?:the )?(?:Inbox|Runs|Backlog|Repos|Fleet|Settings|Ask|Analytics|Help)";

/**
 * Hint text about where things are (rule 3, Decided `no-location-hints`): if the layout needs
 * it, the layout is wrong. Text that says what a setting does or what a change causes stays.
 */
export const BANNED_HINTS: readonly BannedPhrase[] = [
  {
    id: "own-tab",
    pattern: /\bha(?:ve|s) (?:their|its) own (?:tab|page|section)s?\b/i,
    example: "Problems and running work have their own tabs",
  },
  {
    id: "is-in-screen",
    pattern: new RegExp(`\\b(?:is|are) (?:now )?(?:in|on|under) ${SCREENS}\\b`),
    example: "Finished work is in Runs",
  },
  {
    id: "lives-in",
    pattern: /\blives? (?:in|on|under)\b/i,
    example: "The diff lives in the step panel",
  },
  {
    id: "can-be-found",
    pattern: /\bcan (?:be found|find (?:it|them|this|these)) (?:in|on|under)\b/i,
    example: "Older runs can be found in Analytics",
  },
  {
    id: "see-the-tab",
    pattern: /\bsee the [\w -]{1,40}? (?:tab|page|section|panel|menu)\b/i,
    example: "See the Problems tab",
  },
  {
    id: "go-to-to",
    pattern: /\bgo to [\w -]{1,40}? to\b/i,
    example: "Go to Settings to connect Linear",
  },
  { id: "head-to", pattern: /\bhead (?:over )?to\b/i, example: "Head over to Fleet" },
  {
    id: "moved-to",
    pattern: /\b(?:has|have) (?:been )?moved to\b/i,
    example: "Reviews have moved to Runs",
  },
];

/**
 * A "Live" or "Updated" indicator (rules 9 and 22, Decided `no-live-indicator`): the whole UI
 * is live, so only a stop in live updates is worth a notice.
 */
export const LIVE_INDICATORS: readonly BannedPhrase[] = [
  // Capitalized, as shown: a lowercase "live" or "updated" in code is a state or a field.
  { id: "live", pattern: /\bLive\b/, example: "Live" },
  {
    id: "updated",
    pattern:
      /^\s*Updated\s*$|\bUpdated (?:just now|now|\d|an? |a few|seconds?\b|minutes?\b|moments?\b|at\b|\w+ ago\b)|\bupdated (?:just now|\d+\s*\w* ago\b|\w+ ago\b)/,
    example: "Updated 2m ago",
  },
  {
    id: "last-updated",
    pattern: /\b[Ll]ast (?:updated|refreshed|synced)\b/,
    example: "Last updated 10:42",
  },
];

/** "… ago": an indicator only next to a refresh control ("3m ago ⟳"), not as a row's time. */
export const AGO = /\bago\b/i;

/** Names a refresh control, whose "… ago" next to it is an "Updated" indicator. */
export const REFRESH_CONTROL = /\b(?:refresh|reload)\b/i;

/**
 * The one text the indicator rule allows: `LiveNotice`'s, shown only while live updates have
 * stopped (`LIVE_NOTICE_MESSAGE` in `@omniralph/ui`).
 */
export const LIVE_INDICATOR_ALLOWED: readonly string[] = ["Live updates stopped. Retrying…"];

/**
 * A legal document's revision date ("Last updated: October 9, 2026" on Terms and Privacy): when
 * the text changed, not how fresh the page is.
 */
export const DOCUMENT_REVISION_DATE = /^Last updated: [A-Z][a-z]+ \d{1,2}, \d{4}$/;

/** The phrases of `list` that `text` matches. */
export function bannedIn(text: string, list: readonly BannedPhrase[]): BannedPhrase[] {
  return list.filter((phrase) => phrase.pattern.test(text));
}

/** The lists as `[source, flags]` pairs, for code that can't import this module (in a page). */
export function patternSources(list: readonly BannedPhrase[]): [string, string][] {
  return list.map(({ pattern }) => [pattern.source, pattern.flags]);
}
