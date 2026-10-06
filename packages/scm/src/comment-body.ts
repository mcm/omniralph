import type { InlineComment } from "./types.js";

/** A code fence longer than any backtick run inside `content`. */
function fenceFor(content: string): string {
  const longest = Math.max(0, ...[...content.matchAll(/`+/g)].map((m) => m[0].length));
  return "`".repeat(Math.max(3, longest + 1));
}

/** Renders `content` as a fenced block with the given info string. */
export function fencedBlock(info: string, content: string): string {
  const fence = fenceFor(content);
  const body = content.endsWith("\n") ? content : `${content}\n`;
  return `${fence}${info}\n${body}${fence}`;
}

/** Body of an inline comment, with its suggestion as a `suggestion` block. */
export function renderInlineComment(comment: InlineComment): string {
  if (comment.suggestion === undefined) return comment.body;
  return `${comment.body}\n\n${fencedBlock("suggestion", comment.suggestion)}`;
}

function lineLabel(comment: InlineComment): string {
  const range =
    comment.startLine !== undefined && comment.startLine !== comment.line
      ? `L${comment.startLine}-L${comment.line}`
      : `L${comment.line}`;
  return comment.side === "old" ? `${range} (old)` : range;
}

/**
 * Appends comments that couldn't be posted inline (their lines aren't in the
 * diff) to the summary. Suggestions become plain code blocks: a `suggestion`
 * block only applies inside an inline comment.
 */
export function summaryWithFallbacks(summary: string, fallbacks: InlineComment[]): string {
  if (fallbacks.length === 0) return summary;
  const items = fallbacks.map((comment) => {
    const heading = `**\`${comment.path}\`** ${lineLabel(comment)}`;
    const suggestion =
      comment.suggestion === undefined ? "" : `\n\n${fencedBlock("", comment.suggestion)}`;
    return `${heading}\n\n${comment.body}${suggestion}`;
  });
  return `${summary}\n\n### Comments outside the diff\n\n${items.join("\n\n---\n\n")}`;
}

/** Truncates a comment body to a provider's maximum length. */
export function capLength(body: string, max: number): string {
  if (body.length <= max) return body;
  const marker = "\n\n_…truncated_";
  return body.slice(0, max - marker.length) + marker;
}

/** Caps a one-line title at `max` characters, ending it with `…` when cut. */
export function capTitle(title: string, max: number): string {
  const line = title.replace(/\s+/g, " ").trim();
  if (line.length <= max) return line;
  return `${line.slice(0, max - 1).trimEnd()}…`;
}
