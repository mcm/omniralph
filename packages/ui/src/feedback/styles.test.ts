import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "feedback.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const MEDIA = /@media([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g;

function rule(source: string, selector: string): Record<string, string> {
  const match = Array.from(source.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
    selectors!.split(",").some((part) => part.trim() === selector),
  );
  expect(match, selector).toBeDefined();
  return Object.fromEntries(
    match![2]!
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  );
}

describe("feedback.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/feedback\.css"/,
    );
  });

  it("places toasts bottom-right above 768 px", () => {
    const toaster = rule(css.replace(MEDIA, ""), ".or-toaster");
    expect(toaster.position).toBe("fixed");
    expect(toaster.right).toBe("20px");
    expect(toaster.bottom).toBe("20px");
    expect(toaster.left).toBeUndefined();
  });

  it("places toasts above the tab bar at 768 px and narrower", () => {
    const phone = Array.from(css.matchAll(MEDIA)).find(
      ([, condition]) => condition!.trim() === "(max-width: 768px)",
    );
    expect(phone).toBeDefined();
    const toaster = rule(phone![2]!, ".or-toaster");
    // The tab bar is 52 px tabs + 2 × 6 px padding + a 1 px rule, plus the safe area.
    expect(toaster.bottom).toBe("calc(77px + env(safe-area-inset-bottom))");
    const tabbar = readFileSync(path.join(stylesDir, "shell.css"), "utf8");
    expect(tabbar).toMatch(/\.or-nav__item--tab \{[^}]*height: 52px/);
    expect(tabbar).toMatch(
      /\.or-tabbar \{[^}]*padding: 6px 8px calc\(6px \+ env\(safe-area-inset-bottom\)\)/,
    );
  });

  it("never uses the accent for a toast's tone", () => {
    expect(css.replace(/\.or-toast__dismiss:focus-visible \{[^}]*\}/, "")).not.toMatch(/--or-acc/);
  });
});
