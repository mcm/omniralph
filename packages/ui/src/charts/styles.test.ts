import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const here = path.dirname(fileURLToPath(import.meta.url));
const stylesDir = path.resolve(here, "../../styles");
const css = readFileSync(path.join(stylesDir, "charts.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const phone = /@media\s*\(max-width:\s*768px\)\s*\{([\s\S]*)\}\s*$/.exec(css)?.[1] ?? "";
const topLevel = css.slice(0, css.search(/@media/));

function declarations(source: string, selector: string): Record<string, string> {
  const rule = Array.from(source.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
    selectors!.split(",").some((part) => part.trim() === selector),
  );
  return Object.fromEntries(
    (rule?.[2] ?? "")
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  );
}

describe("charts.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/charts\.css"/,
    );
  });

  it("draws bars in neutral tokens only: --or-sec, --or-text on hover", () => {
    expect(declarations(topLevel, ".or-chart__bar").fill).toBe("var(--or-sec)");
    expect(declarations(topLevel, ".or-chart__bar:hover").fill).toBe("var(--or-text)");
    // Never the accent (lavender means needs you), mint or coral.
    expect(css).not.toMatch(/--or-(acc|run|fail|halo|glow)/);
  });

  it("sets ticks and labels in Geist Mono, --or-ter", () => {
    const text = declarations(topLevel, ".or-chart__tick");
    expect(text["font-family"]).toBe("var(--or-font-mono)");
    expect(text.color).toBe("var(--or-ter)");
    expect(declarations(topLevel, ".or-chart__label")).toEqual(
      declarations(topLevel, ".or-chart__tick"),
    );
  });

  it("is 180 px tall, 140 px at 768 px and narrower, with only the first and last label", () => {
    expect(declarations(topLevel, ".or-chart")["--or-chart-height"]).toBe("180px");
    expect(declarations(topLevel, ".or-chart__svg").height).toBe("var(--or-chart-height)");
    expect(declarations(phone, ".or-chart")["--or-chart-height"]).toBe("140px");
    expect(declarations(phone, ".or-chart__label--middle").display).toBe("none");
  });

  it("imports no chart library in the chart components", () => {
    const sources = readdirSync(here)
      .filter((file) => /\.tsx?$/.test(file) && !file.endsWith(".test.ts"))
      .map((file) => readFileSync(path.join(here, file), "utf8"));
    for (const source of sources) {
      const specifiers = Array.from(
        source.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)["']([^"']+)["']/g),
        ([, specifier]) => specifier!,
      );
      expect(
        specifiers.filter(
          (specifier) =>
            !specifier.startsWith(".") &&
            !["react", "vitest", "@testing-library/react", "@testing-library/user-event"].includes(
              specifier,
            ),
        ),
      ).toEqual([]);
    }
  });
});
