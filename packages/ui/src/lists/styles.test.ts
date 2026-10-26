import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "lists.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const mediaPattern = /@media([^{]*)\{((?:[^{}]*\{[^}]*\})*)\s*\}/g;
const topLevel = css.replace(mediaPattern, "");

function rules(source: string): Map<string, Record<string, string>> {
  const result = new Map<string, Record<string, string>>();
  for (const [, selectors, body] of source.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    const declarations = Object.fromEntries(
      body!
        .split(";")
        .map((declaration) => declaration.trim())
        .filter(Boolean)
        .map((declaration) => {
          const colon = declaration.indexOf(":");
          return [declaration.slice(0, colon).trim(), declaration.slice(colon + 1).trim()];
        }),
    );
    for (const selector of selectors!.split(",")) {
      const key = selector.trim();
      result.set(key, { ...result.get(key), ...declarations });
    }
  }
  return result;
}

const top = rules(topLevel);
const media = new Map(
  Array.from(css.matchAll(mediaPattern)).map(([, query, body]) => [query!.trim(), rules(body!)]),
);

describe("lists.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/lists\.css"/,
    );
  });

  it("shows the table and hides the cards above 768 px", () => {
    expect(top.get(".or-tblwrap")?.display).toBe("block");
    expect(top.get(".or-cards")?.display).toBe("none");
  });

  it("hides the table and shows the cards at 768 px and narrower", () => {
    const phone = media.get("(max-width: 768px)");
    expect(phone).toBeDefined();
    expect(phone!.get(".or-tblwrap")?.display).toBe("none");
    expect(phone!.get(".or-cards")?.display).toBe("flex");
  });

  it("gives the activity date a fixed-width mono column", () => {
    expect(top.get(".or-activity__date")).toMatchObject({ flex: "none", width: "92px" });
    expect(top.get(".or-activity__entry")?.display).toBe("flex");
  });

  it("styles selected and bad rows", () => {
    expect(top.get('.or-tbl__row[aria-current="true"]')?.background).toBe("var(--or-sel)");
    expect(top.get('.or-cardrow[aria-current="true"]')?.background).toBe("var(--or-sel)");
    expect(top.get('.or-row[aria-current="true"]')?.background).toBe("var(--or-sel)");
    expect(top.get(".or-tbl__row--bad")?.background).toBe("var(--or-fail-tint)");
    expect(top.get(".or-cardrow--bad")?.background).toBe("var(--or-fail-tint)");
  });

  it("stretches the row link over the row, with the row's controls above it", () => {
    expect(top.get(".or-row")?.position).toBe("relative");
    expect(top.get(".or-row__link")).toMatchObject({ position: "absolute", inset: "0" });
    expect(top.get(".or-row__select")).toMatchObject({ position: "relative", "z-index": "1" });
    expect(top.get(".or-row__actions")).toMatchObject({ position: "relative", "z-index": "1" });
    expect(top.get(".or-row-link::after")).toMatchObject({ position: "absolute", inset: "0" });
    expect(top.get(".or-cardrow")?.position).toBe("relative");
    expect(top.get(".or-tbl__row--linked")?.position).toBe("relative");
  });

  it("gives the time a fixed-width slot and clamps the title to two lines", () => {
    expect(top.get(".or-row__time")).toMatchObject({ flex: "none", width: "44px" });
    expect(top.get(".or-row__title")).toMatchObject({
      overflow: "hidden",
      "-webkit-line-clamp": "2",
      "-webkit-box-orient": "vertical",
      display: "-webkit-box",
    });
  });
});
