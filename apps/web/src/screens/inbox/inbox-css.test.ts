import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const css = readFileSync(path.join(__dirname, "inbox.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

describe("inbox.css", () => {
  it("is imported by the Inbox view", () => {
    expect(readFileSync(path.join(__dirname, "inbox-view.tsx"), "utf8")).toMatch(
      /import\s+"\.\/inbox\.css";/,
    );
  });

  it("uses no color literals (hex, rgb, hsl and the like)", () => {
    expect(css.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi)).toBeNull();
  });

  it("uses only --or- tokens and or- classes", () => {
    const tokens = Array.from(css.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
    expect(tokens.length).toBeGreaterThan(0);
    expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
    const classes = Array.from(css.matchAll(/\.([a-z][\w-]*)/gi), ([, name]) => name!);
    expect(classes.filter((name) => !name.startsWith("or-"))).toEqual([]);
  });
});
