import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "brand.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

function declarations(selector: string): Record<string, string> {
  const rule = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(
    ([, selectors]) => selectors!.trim() === selector,
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

describe("brand.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/brand\.css"/,
    );
  });

  it("sets the wordmark at 17 px, weight 600", () => {
    expect(declarations(".or-wordmark")).toMatchObject({
      "font-size": "17px",
      "font-weight": "600",
    });
  });

  it("lays the glyph and wordmark out inline so they share a baseline", () => {
    expect(declarations(".or-lockup")).toMatchObject({ display: "inline-block" });
    expect(declarations(".or-lockup .or-glyph")["vertical-align"]).toBe("-6.5px");
  });
});
