import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("./styles.css", import.meta.url), "utf8");

/** The body of the `@media (max-width: 768px)` block. */
function narrowRules(): string {
  const start = css.indexOf("@media (max-width: 768px)");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  for (let index = css.indexOf("{", start); index < css.length; index += 1) {
    if (css[index] === "{") depth += 1;
    if (css[index] === "}" && --depth === 0) return css.slice(start, index);
  }
  throw new Error("unclosed @media block");
}

describe("the agent page's stylesheet", () => {
  it("uses only --or- tokens", () => {
    const variables = [...css.matchAll(/var\((--[a-z-]+)/g)].map((match) => match[1]!);
    expect(variables.length).toBeGreaterThan(0);
    expect(variables.filter((name) => !name.startsWith("--or-"))).toEqual([]);
  });

  it("fills the viewport with the top bar above the split view", () => {
    expect(css).toMatch(/\.agent-page,\s*\.agent-reopen\s*\{[^}]*height:\s*100dvh/);
    expect(css).toMatch(/\.agent-split\s*\{[^}]*flex:\s*1 1 auto/);
  });

  it("wraps the top bar's badges instead of overflowing", () => {
    expect(css).toMatch(/\.agent-topbar\s*\{[^}]*flex-wrap:\s*wrap/);
    expect(css).toMatch(/\.agent-topbar__facts\s*\{[^}]*flex-wrap:\s*wrap/);
  });

  it("tightens the top bar and the pages at 768 px and narrower", () => {
    const narrow = narrowRules();
    expect(narrow).toMatch(/\.agent-topbar\s*\{[^}]*padding:\s*10px 16px/);
    expect(narrow).toMatch(/\.agent-section\s*\{[^}]*padding:\s*16px/);
  });
});
