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

  it("colors each status tone from its token", () => {
    const status = read("status.css");
    expect(declarations(status, ".or-dot--need")).toEqual({
      background: "var(--or-acc)",
      "box-shadow": "0 0 0 3px var(--or-halo)",
    });
    expect(declarations(status, ".or-dot--run")).toEqual({
      background: "var(--or-run)",
      "box-shadow": "0 0 0 3px var(--or-run-glow)",
    });
    expect(declarations(status, ".or-dot--good")).toEqual({ background: "var(--or-run)" });
    expect(declarations(status, ".or-dot--fail")).toEqual({ background: "var(--or-fail)" });
    expect(declarations(status, ".or-dot--neutral")).toEqual({ background: "var(--or-done)" });
    expect(declarations(status, ".or-status--need").color).toBe("var(--or-acc)");
    expect(declarations(status, ".or-status--run").color).toBe("var(--or-run)");
    expect(declarations(status, ".or-status--good").color).toBe("var(--or-run)");
    expect(declarations(status, ".or-status--fail").color).toBe("var(--or-fail)");
    expect(declarations(status, ".or-status--neutral").color).toBe("var(--or-sec)");
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
