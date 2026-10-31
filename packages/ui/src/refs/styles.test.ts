import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");

function read(file: string): string {
  return readFileSync(path.join(stylesDir, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
}

function declarations(css: string, selector: string): Record<string, string> {
  const rule = Array.from(css.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
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

describe("refs.css and status.css", () => {
  it("are imported by styles.css", () => {
    const index = read("index.css");
    expect(index).toMatch(/@import\s+"\.\/refs\.css"/);
    expect(index).toMatch(/@import\s+"\.\/status\.css"/);
  });

  it("truncates badge text with an ellipsis", () => {
    const refs = read("refs.css");
    expect(declarations(refs, ".or-ref")).toMatchObject({ "min-width": "0", "max-width": "100%" });
    expect(declarations(refs, ".or-ref__text")).toMatchObject({
      overflow: "hidden",
      "text-overflow": "ellipsis",
      "white-space": "nowrap",
    });
  });
});

describe("component CSS", () => {
  it("uses no color literals outside tokens.css", () => {
    const files = readdirSync(stylesDir).filter(
      (file) => file.endsWith(".css") && file !== "tokens.css",
    );
    expect(files).toEqual(expect.arrayContaining(["refs.css", "status.css", "layout.css"]));
    for (const file of files) {
      const literals = read(file).match(
        /#[0-9a-f]{3,8}\b|\b(?:rgba?|hsla?|hwb|lab|lch|oklab|oklch)\(/gi,
      );
      expect({ file, literals }).toEqual({ file, literals: null });
    }
  });
});
