/**
 * The ralph progress log: an append-only markdown document the agent writes learnings to after
 * each story, with a "Codebase Patterns" section at the top that is fed into every prompt.
 * Each story runs with a fresh context window, so this log is the loop's long-term memory.
 * In cyralph it was a `progress.md` file; here it is text (`ralph_runs.progress`).
 */

export const PROGRESS_HEADER = `# Ralph Progress Log

## Codebase Patterns (Study These First)
*Add reusable patterns discovered during development here.*

---
`;

/** A new run's progress log. */
export function initialProgress(epicTitle: string): string {
  return `${PROGRESS_HEADER}\nEpic: ${epicTitle}\n\n`;
}

/** `progress` with `entry` appended (trimmed, on its own lines). A blank entry changes nothing. */
export function appendProgress(progress: string, entry: string): string {
  const text = entry.trim();
  if (!text) return progress;
  return `${progress}\n${text}\n`;
}

/**
 * What a session added to the log: the text after `before` when `after` extends it, else (the
 * session rewrote earlier parts, e.g. the Codebase Patterns) `after` whole. Undefined when unchanged.
 */
export function progressAddition(before: string, after: string): string | undefined {
  if (after === before) return undefined;
  const added = after.startsWith(before) ? after.slice(before.length) : after;
  return added.trim() || undefined;
}

/** The `## Codebase Patterns` section body, or undefined if empty/placeholder. */
export function extractCodebasePatterns(progress: string): string | undefined {
  const m = /^## Codebase Patterns[^\n]*\n([\s\S]*?)(?=^---\s*$|^## (?!Codebase)|(?![\s\S]))/m.exec(
    progress,
  );
  const body = m?.[1]?.trim();
  if (!body || /^\*Add reusable patterns/.test(body)) return undefined;
  return body;
}

/** The last `count` story entries (sections starting with `## ` other than Codebase Patterns). */
export function recentProgressEntries(progress: string, count = 5): string | undefined {
  const parts = progress
    .split(/^(?=## )/m)
    .filter((p) => p.startsWith("## ") && !p.startsWith("## Codebase Patterns"));
  if (parts.length === 0) return undefined;
  return parts
    .slice(-count)
    .map((p) => p.trim())
    .join("\n\n");
}
