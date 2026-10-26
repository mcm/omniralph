import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "content.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const rules = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g)).map(([, selectors, body]) => ({
  selectors: selectors!.split(",").map((part) => part.trim()),
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

function declarations(selector: string): Record<string, string> {
  return Object.assign(
    {},
    ...rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.declarations),
  );
}

describe("content.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/content\.css"/,
    );
  });

  it("takes every color, font and radius from the --or- tokens", () => {
    const tokenOnly =
      /^(color|background|border(-(top|right|bottom|left))?|outline|font-family|border-radius|accent-color)$/;
    for (const rule of rules) {
      for (const [property, value] of Object.entries(rule.declarations)) {
        if (!tokenOnly.test(property) || /^(0|none|transparent|inherit)$/.test(value)) continue;
        expect(value, `${rule.selectors.join(", ")} { ${property} }`).toMatch(/var\(--or-[\w-]+\)/);
        expect(value, `${rule.selectors.join(", ")} { ${property} }`).not.toMatch(
          /#[0-9a-f]{3,8}\b|rgb/i,
        );
      }
    }
  });

  it("styles headings, lists, code, tables and links", () => {
    expect(declarations(".or-md h2")["font-size"]).toBeDefined();
    expect(declarations(".or-md h1").color).toBe("var(--or-text)");
    expect(declarations(".or-md ul")["padding-left"]).toBeDefined();
    expect(declarations(".or-md code")["font-family"]).toBe("var(--or-font-mono)");
    expect(declarations(".or-md pre").background).toBe("var(--or-raised)");
    expect(declarations(".or-md th").border).toBe("1px solid var(--or-line)");
    expect(declarations(".or-md__table")["overflow-x"]).toBe("auto");
    expect(declarations(".or-md a").color).toBe("var(--or-acc)");
  });

  it("numbers the Quality Gates list and boxes the Open Questions callout", () => {
    expect(declarations(".or-md .or-md__gates")["list-style"]).toBe("decimal");
    const callout = declarations(".or-md__callout");
    expect(callout.border).toBe("1px solid var(--or-border)");
    expect(callout.background).toBe("var(--or-surf)");
  });
});
