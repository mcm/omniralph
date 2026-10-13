import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { FINDING_SEVERITIES } from "@/lib/reviews/display";

// Measures the severity chips the way they render: each `.severity-<severity>` rule in
// globals.css, resolved against the library's theme tokens, then the WCAG contrast of the
// chip's text, border and fill against the card surface it sits on. Prominence is the
// three together, and the ramp critical > high > medium > low > info has to hold for each
// in both themes.

const libraryCss = readFileSync(
  createRequire(import.meta.url).resolve("@iamthemcmaster/ui/styles"),
  "utf8",
);
const panelCss = readFileSync(resolve(__dirname, "../app/globals.css"), "utf8");

type Rgba = [number, number, number, number];
type Theme = "dark" | "light";

function declarations(block: string): Map<string, string> {
  const map = new Map<string, string>();
  for (const decl of block.split(";")) {
    const colon = decl.indexOf(":");
    if (colon > 0) map.set(decl.slice(0, colon).trim(), decl.slice(colon + 1).trim());
  }
  return map;
}

/** The theme's custom properties: the palette (defined once) under the theme block. */
function themeTokens(theme: Theme): Map<string, string> {
  const tokens = new Map<string, string>();
  for (const [, name, value] of libraryCss.matchAll(/(--[a-z0-9-]+):([^;{}]+)/g)) {
    if (!tokens.has(name!)) tokens.set(name!, value!.trim());
  }
  const block = libraryCss.match(new RegExp(`\\[data-theme=${theme}\\]\\{([^}]*)\\}`))?.[1];
  if (!block) throw new Error(`no [data-theme=${theme}] block in the library CSS`);
  for (const [name, value] of declarations(block)) tokens.set(name, value);
  return tokens;
}

function parseHex(hex: string): Rgba {
  let h = hex.slice(1);
  if (h.length <= 4) h = [...h].map((c) => c + c).join("");
  const n = (i: number) => parseInt(h.slice(i, i + 2), 16);
  return [n(0), n(2), n(4), h.length === 8 ? n(6) / 255 : 1];
}

/** Splits on top-level commas only (not inside nested `var()`/`color-mix()`). */
function splitArgs(args: string): string[] {
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  [...args].forEach((c, i) => {
    if (c === "(") depth++;
    else if (c === ")") depth--;
    else if (c === "," && depth === 0) {
      parts.push(args.slice(start, i).trim());
      start = i + 1;
    }
  });
  parts.push(args.slice(start).trim());
  return parts;
}

function color(value: string, tokens: Map<string, string>): Rgba {
  const v = value.trim();
  if (v === "transparent") return [0, 0, 0, 0];
  if (v.startsWith("#")) return parseHex(v);
  const fn = v.match(/^([a-z-]+)\((.*)\)$/);
  if (fn?.[1] === "var") {
    const name = splitArgs(fn[2]!)[0]!;
    const token = tokens.get(name);
    if (!token) throw new Error(`unknown token ${name}`);
    return color(token, tokens);
  }
  if (fn?.[1] === "color-mix") {
    // `color-mix(in srgb, A p%, B)`: premultiplied sRGB, B gets the rest.
    const [space, a, b] = splitArgs(fn[2]!);
    expect(space).toBe("in srgb");
    const pct = a!.match(/\s(\d+(?:\.\d+)?)%$/);
    const p = pct ? Number(pct[1]) / 100 : 0.5;
    const ca = color(pct ? a!.slice(0, pct.index) : a!, tokens);
    const cb = color(b!, tokens);
    const alpha = ca[3] * p + cb[3] * (1 - p);
    if (alpha === 0) return [0, 0, 0, 0];
    const mix = (i: number) => (ca[i]! * ca[3] * p + cb[i]! * cb[3] * (1 - p)) / alpha;
    return [mix(0), mix(1), mix(2), alpha];
  }
  throw new Error(`can't resolve colour ${v}`);
}

function over([r, g, b, a]: Rgba, [br, bg, bb]: Rgba): Rgba {
  return [r * a + br * (1 - a), g * a + bg * (1 - a), b * a + bb * (1 - a), 1];
}

function luminance([r, g, b]: Rgba): number {
  const f = (c: number) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function contrast(a: Rgba, b: Rgba): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi! + 0.05) / (lo! + 0.05);
}

function chip(severity: string, theme: Theme) {
  const rule = panelCss.match(
    new RegExp(`\\.severity-${severity}\\.severity-${severity}\\s*\\{([^}]*)\\}`),
  )?.[1];
  if (!rule) throw new Error(`no .severity-${severity} rule in globals.css`);
  const decls = declarations(rule.replace(/\/\*[\s\S]*?\*\//g, ""));
  const tokens = themeTokens(theme);
  const surface = color("var(--bg-surface)", tokens);
  const fill = over(color(decls.get("background-color")!, tokens), surface);
  const text = over(color(decls.get("color")!, tokens), fill);
  const border = over(color(decls.get("border-color")!, tokens), surface);
  return {
    text: contrast(text, surface),
    textOnFill: contrast(text, fill),
    border: contrast(border, surface),
    fill: contrast(fill, surface),
  };
}

describe.each(["dark", "light"] as const)("severity chips in %s", (theme) => {
  const chips = FINDING_SEVERITIES.map((severity) => ({ severity, ...chip(severity, theme) }));
  const steps = chips.slice(1).map((quieter, i) => [chips[i]!, quieter] as const);

  it("keeps every chip's text at WCAG AA on its own fill", () => {
    for (const c of chips) expect(c.textOnFill, c.severity).toBeGreaterThanOrEqual(4.5);
  });

  it("gets quieter at every step: text and border never louder, prominence always lower", () => {
    for (const [louder, quieter] of steps) {
      const step = `${louder.severity} > ${quieter.severity}`;
      expect(quieter.text, `${step} text`).toBeLessThan(louder.text);
      expect(quieter.border, `${step} border`).toBeLessThanOrEqual(louder.border);
      expect(quieter.text + quieter.border + quieter.fill, `${step} total`).toBeLessThan(
        louder.text + louder.border + louder.fill,
      );
    }
  });

  it("separates medium from high and low by a visible step", () => {
    const [, high, medium, low] = chips;
    // Text and border together drop by at least 0.5:1 either side of medium.
    expect(high!.text + high!.border - (medium!.text + medium!.border)).toBeGreaterThan(0.5);
    expect(medium!.text + medium!.border - (low!.text + low!.border)).toBeGreaterThan(0.5);
  });
});
