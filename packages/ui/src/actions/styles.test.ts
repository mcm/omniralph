import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "actions.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** Every rule in the stylesheet as { selectors, declarations }. */
const rules = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g), ([, selectors, body]) => ({
  selectors: selectors!.split(",").map((selector) => selector.trim()),
  declarations: Object.fromEntries(
    body!
      .split(";")
      .map((declaration) => declaration.trim())
      .filter(Boolean)
      .map((declaration) => {
        const colon = declaration.indexOf(":");
        return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
      }),
  ) as Record<string, string>,
}));

describe("actions.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/actions\.css"/,
    );
  });

  it("draws primary in the accent with the glow", () => {
    const primary = rules.find((rule) => rule.selectors.includes(".or-btn--primary"));
    expect(primary?.declarations).toMatchObject({
      background: "var(--or-acc)",
      color: "var(--or-acc-ink)",
      "box-shadow": "var(--or-glow)",
    });
  });

  it("gives no other rule a box-shadow", () => {
    const shadowed = rules
      .filter((rule) => "box-shadow" in rule.declarations)
      .flatMap((rule) => rule.selectors);
    expect(shadowed).toEqual([".or-btn--primary"]);
  });

  it("sizes md at 36 px and sm at 30 px", () => {
    const height = (selector: string) =>
      rules.find((rule) => rule.selectors.includes(selector))?.declarations.height;
    expect(height(".or-btn")).toBe("36px");
    expect(height(".or-btn--sm")).toBe("30px");
    expect(height(".or-icon-btn")).toBe("36px");
    expect(height(".or-icon-btn--sm")).toBe("30px");
  });

  it("draws destructive menu items and the danger button in coral", () => {
    const color = (selector: string) =>
      rules.find((rule) => rule.selectors.includes(selector))?.declarations.color;
    expect(color(".or-menu__item--danger")).toBe("var(--or-fail)");
    expect(color(".or-btn--danger")).toBe("var(--or-fail)");
  });
});
