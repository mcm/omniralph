import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { contrastRatio } from "./contrast.js";
import { parseTokenBlocks } from "./parse.js";

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles/tokens.css"),
  "utf8",
);
const blocks = parseTokenBlocks(css);

const THEMES = [
  ["dark", ':root, [data-theme="dark"]'],
  ["light", '[data-theme="light"]'],
] as const;

const SURFACES = ["page", "side", "surf", "raised", "sel", "hover"];
const TEXT_PAIRS = ["text", "sec", "ter", "acc", "run", "fail"].flatMap((fg) =>
  SURFACES.map((bg) => [fg, bg, 4.5] as const),
);
const PAIRS: (readonly [string, string, number])[] = [
  ...TEXT_PAIRS,
  ["acc-ink", "acc", 4.5],
  ["solid-ink", "solid", 4.5],
  ...["page", "side", "surf", "raised"].map((bg) => ["ctl", bg, 3] as const),
  // The neutral status dot (done, pending, blocked steps; idle agents) is a graphic that
  // can be the only cue of a state (WCAG 1.4.11).
  ...SURFACES.map((bg) => ["done", bg, 3] as const),
];

describe("contrastRatio", () => {
  it("matches WCAG's extremes", () => {
    expect(contrastRatio("#000000", "#FFFFFF")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777", "#777")).toBe(1);
  });
});

describe.each(THEMES)("%s token contrast", (theme, selector) => {
  const tokens = blocks.get(selector)!;

  it.each(PAIRS)("--or-%s on --or-%s is at least %s:1", (fg, bg, minimum) => {
    const ratio = contrastRatio(tokens[fg]!, tokens[bg]!);
    expect(
      ratio,
      `${theme}: --or-${fg} on --or-${bg} is ${ratio.toFixed(2)}:1, below ${minimum}:1`,
    ).toBeGreaterThanOrEqual(minimum);
  });
});
