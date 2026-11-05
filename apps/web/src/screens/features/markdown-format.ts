/**
 * The document editor's formatting commands: each takes the text and the selection and
 * answers the new text and selection, writing Markdown (the format PRFAQs and Plans are
 * stored, read by the PRD plugin and sharded in).
 */

export interface TextSelection {
  text: string;
  start: number;
  end: number;
}

export type FormatCommand =
  | "heading"
  | "bold"
  | "italic"
  | "bulletList"
  | "numberedList"
  | "quote"
  | "code"
  | "link";

/** Wraps the selection in `before`/`after`, or unwraps it when it's already wrapped. */
function wrap(selection: TextSelection, before: string, after: string, placeholder: string) {
  const { text, start, end } = selection;
  const outer = text.slice(start - before.length, end + after.length);
  if (
    start >= before.length &&
    outer.startsWith(before) &&
    outer.endsWith(after) &&
    outer.length >= before.length + after.length
  ) {
    return {
      text:
        text.slice(0, start - before.length) +
        text.slice(start, end) +
        text.slice(end + after.length),
      start: start - before.length,
      end: end - before.length,
    };
  }
  const inner = text.slice(start, end) || placeholder;
  return {
    text: text.slice(0, start) + before + inner + after + text.slice(end),
    start: start + before.length,
    end: start + before.length + inner.length,
  };
}

/** The selection widened to whole lines. */
function lineRange({ text, start, end }: TextSelection): { from: number; to: number } {
  const from = text.lastIndexOf("\n", start - 1) + 1;
  const newline = text.indexOf("\n", end > start && text[end - 1] === "\n" ? end - 1 : end);
  return { from, to: newline === -1 ? text.length : newline };
}

/**
 * Prefixes every selected line (`prefix(index)`), or takes the prefix off when every line
 * already has it (`pattern`).
 */
function prefixLines(
  selection: TextSelection,
  pattern: RegExp,
  prefix: (index: number) => string,
): TextSelection {
  const { text } = selection;
  const { from, to } = lineRange(selection);
  const lines = text.slice(from, to).split("\n");
  const toggleOff = lines.every((line) => pattern.test(line));
  const next = lines
    .map((line, index) =>
      toggleOff ? line.replace(pattern, "") : prefix(index) + line.replace(pattern, ""),
    )
    .join("\n");
  return {
    text: text.slice(0, from) + next + text.slice(to),
    start: from,
    end: from + next.length,
  };
}

/** Applies a formatting command to the selection. */
export function applyFormat(command: FormatCommand, selection: TextSelection): TextSelection {
  switch (command) {
    case "bold":
      return wrap(selection, "**", "**", "bold text");
    case "italic":
      return wrap(selection, "_", "_", "italic text");
    case "code":
      return wrap(selection, "`", "`", "code");
    case "heading":
      return prefixLines(selection, /^## /, () => "## ");
    case "bulletList":
      return prefixLines(selection, /^- /, () => "- ");
    case "numberedList":
      return prefixLines(selection, /^\d+\. /, (index) => `${index + 1}. `);
    case "quote":
      return prefixLines(selection, /^> /, () => "> ");
    case "link": {
      const { text, start, end } = selection;
      const label = text.slice(start, end) || "link text";
      const inserted = `[${label}](https://)`;
      // Selects the URL, ready to type over.
      const urlStart = start + label.length + 3;
      return {
        text: text.slice(0, start) + inserted + text.slice(end),
        start: urlStart,
        end: urlStart + "https://".length,
      };
    }
  }
}
