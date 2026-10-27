import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(path.join(__dirname, file), "utf8");
const css = read("backlog.css").replace(/\/\*[\s\S]*?\*\//g, "");
const blockedCss = readFileSync(
  path.join(__dirname, "../../components/work-items/blocked.css"),
  "utf8",
).replace(/\/\*[\s\S]*?\*\//g, "");

describe("backlog.css", () => {
  it("is imported by the Backlog view", () => {
    expect(read("backlog-view.tsx")).toMatch(/import\s+"\.\/backlog\.css";/);
  });

  it.each([
    ["backlog.css", css],
    ["blocked.css", blockedCss],
  ])("%s uses no color literals and only --or- tokens and or- classes", (_name, text) => {
    expect(text.match(/#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi)).toBeNull();
    const tokens = Array.from(text.matchAll(/var\((--[\w-]+)/g), ([, name]) => name!);
    expect(tokens.filter((name) => !name.startsWith("--or-"))).toEqual([]);
    const classes = Array.from(text.matchAll(/\.([a-z][\w-]*)/gi), ([, name]) => name!);
    expect(classes.filter((name) => !name.startsWith("or-"))).toEqual([]);
  });

  it("leaves the split to SplitView: no widths, container queries or pane rules of its own", () => {
    expect(css).not.toMatch(/--or-split-/);
    expect(css).not.toMatch(/@container|@media/);
    expect(css).not.toMatch(/\.or-split/);
    expect(css).not.toMatch(/grid-template-columns/);
    expect(read("backlog-view.tsx")).not.toMatch(/listWidth=/);
  });
});
