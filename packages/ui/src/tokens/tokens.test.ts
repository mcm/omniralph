import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { normalizeColor, parseTokenBlocks } from "./parse.js";

const css = readFileSync(
  path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles/tokens.css"),
  "utf8",
);
const blocks = parseTokenBlocks(css);

const DARK_SELECTOR = ':root, [data-theme="dark"]';
const LIGHT_SELECTOR = '[data-theme="light"]';

// The epic's token table (canvas ui.css): [dark, light].
const COLOR_TOKENS: Record<string, [string, string]> = {
  page: ["#0A0810", "#F5F3EE"],
  side: ["#0D0B14", "#EFECE6"],
  surf: ["#110E1A", "#FFFFFF"],
  raised: ["#17131F", "#F5F3EE"],
  sel: ["#1C1729", "#E9E4EF"],
  hover: ["#15111F", "#ECE8EF"],
  line: ["#1B1726", "#E5E1DA"],
  border: ["#2A2338", "#DDD7D0"],
  ctl: ["#7A6E94", "#85808F"],
  text: ["#ECE8F4", "#17151C"],
  sec: ["#A79FBA", "#57535F"],
  ter: ["#8A82A0", "#67636F"],
  acc: ["#B294FF", "#6236D6"],
  "acc-ink": ["#0A0810", "#FFFFFF"],
  "acc-hover": ["#C7B0FF", "#5229C2"],
  halo: ["rgba(178,148,255,.2)", "rgba(98,54,214,.14)"],
  glow: ["0 0 22px rgba(178,148,255,.32)", "0 4px 14px rgba(98,54,214,.25)"],
  run: ["#5EE6D0", "#087064"],
  "run-glow": ["rgba(94,230,208,.16)", "rgba(8,112,100,.14)"],
  fail: ["#FF6B5E", "#C42B2B"],
  "fail-tint": ["#1C1216", "#FBEDEC"],
  done: ["#5E5578", "#968FA1"],
  solid: ["#ECE8F4", "#17151C"],
  "solid-ink": ["#0A0810", "#FFFFFF"],
  "solid-hover": ["#FFFFFF", "#000000"],
};

describe("tokens.css", () => {
  it("has a dark block on :root and [data-theme=dark] and a light block", () => {
    expect(blocks.has(DARK_SELECTOR)).toBe(true);
    expect(blocks.has(LIGHT_SELECTOR)).toBe(true);
  });

  for (const [theme, selector, index] of [
    ["dark", DARK_SELECTOR, 0],
    ["light", LIGHT_SELECTOR, 1],
  ] as const) {
    it.each(Object.entries(COLOR_TOKENS))(
      `defines --or-%s in the ${theme} block with the table's value`,
      (name, values) => {
        const value = blocks.get(selector)?.[name];
        expect(value, `--or-${name} is missing from the ${theme} block`).toBeDefined();
        expect(normalizeColor(value!), `--or-${name} (${theme})`).toBe(
          normalizeColor(values[index]),
        );
      },
    );
  }

  it("defines the fonts, radii and shell widths once for both themes", () => {
    const root = blocks.get(":root");
    expect(root?.["font-sans"]).toMatch(/^"Instrument Sans Variable".*system-ui, sans-serif$/);
    expect(root?.["font-mono"]).toMatch(/^"Geist Mono Variable".*ui-monospace, monospace$/);
    expect(root?.["radius-sm"]).toBe("6px");
    expect(root?.radius).toBe("8px");
    expect(root?.["radius-lg"]).toBe("12px");
    expect(root?.["side-w"]).toBe("232px");
    expect(root?.["rail-w"]).toBe("64px");
  });
});
