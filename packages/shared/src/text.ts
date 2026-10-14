/**
 * Shortening command output and feedback for Linear, which renders markdown
 * and shows terminal escape sequences as text.
 */

// eslint-disable-next-line no-control-regex -- ANSI CSI and OSC escape sequences
const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/g;

/** Text without ANSI colours and other terminal escape sequences. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI, "");
}

const FENCE = /^\s*```/;

/**
 * Feedback cut to about `max` chars for a Linear post: without terminal escape
 * sequences, keeping its opening paragraphs (what failed: "the quality gate
 * `x` failed:") and the end of the rest (the output's last lines). A code
 * block the cut opens in is reopened, so the end still renders as code.
 */
export function excerpt(text: string, max: number): string {
  const clean = stripAnsi(text).trim();
  if (clean.length <= max) return clean;
  const lines = clean.split("\n");
  // The lead: the lines before the first code block, when they fit in half the budget.
  const firstFence = lines.findIndex((line) => FENCE.test(line));
  const leadLines = firstFence === -1 ? [] : lines.slice(0, firstFence);
  const lead = leadLines.join("\n").trim();
  const head = lead.length > 0 && lead.length <= max / 2 ? leadLines : [];
  const budget = max - head.join("\n").length;

  // The end: whole lines from the bottom, as many as fit.
  let start = lines.length;
  let size = 0;
  while (start > head.length && size + lines[start - 1]!.length + 1 <= budget) {
    start -= 1;
    size += lines[start]!.length + 1;
  }
  if (start === lines.length) {
    // One line longer than the budget: its end.
    return [...head, `…${lines.at(-1)!.slice(-budget)}`].join("\n").trim();
  }
  if (start === head.length) return clean;
  const fencesBefore = lines.slice(0, start).filter((line) => FENCE.test(line)).length;
  const insideCode = fencesBefore % 2 === 1;
  const end = lines.slice(start);
  const cut = insideCode ? ["```", "…", ...end] : ["…", ...end];
  return [...head, ...(head.length > 0 ? [""] : []), ...cut]
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * The failing tests a test runner's output names (Vitest's and Jest's
 * `FAIL <file> > <test>` lines), in order and without repeats.
 */
export function failingTests(output: string, limit = 5): string[] {
  const names: string[] = [];
  for (const line of stripAnsi(output).split("\n")) {
    const match = /^\s*FAIL\s+(\S.*?)\s*$/.exec(line);
    if (match && !names.includes(match[1]!)) names.push(match[1]!);
    if (names.length === limit) break;
  }
  return names;
}
