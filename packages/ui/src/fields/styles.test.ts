import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const source = readFileSync(path.join(stylesDir, "fields.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);

/** The body of `@media (max-width: 768px) { ... }`, and the stylesheet without it. */
const mediaMatch = /@media\s*\(max-width:\s*768px\)\s*\{((?:[^{}]*\{[^}]*\})*)\s*\}/.exec(source);
const css = mediaMatch ? source.replace(mediaMatch[0], "") : source;

const parseRules = (text: string) =>
  Array.from(text.matchAll(/([^{}]+)\{([^}]*)\}/g), ([, selectors, body]) => ({
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

const declarationsIn = (text: string) => (selector: string) =>
  Object.assign(
    {},
    ...parseRules(text)
      .filter((rule) => rule.selectors.includes(selector))
      .map((rule) => rule.declarations),
  ) as Record<string, string>;

const declarationsFor = declarationsIn(css);

describe("fields.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/fields\.css"/,
    );
  });

  it("lays a field out as a 200 px + flexible grid", () => {
    expect(declarationsFor(".or-field")).toMatchObject({
      display: "grid",
      "grid-template-columns": "200px minmax(0, 1fr)",
    });
  });

  it("collapses the field to one column below 769 px", () => {
    expect(mediaMatch).not.toBeNull();
    expect(declarationsIn(mediaMatch![1]!)(".or-field")["grid-template-columns"]).toBe(
      "minmax(0, 1fr)",
    );
  });

  it("stacks the label above the control at every width when stacked", () => {
    expect(declarationsFor(".or-field--stacked")["grid-template-columns"]).toBe("minmax(0, 1fr)");
    expect(declarationsFor(".or-field--stacked .or-field__head")["padding-top"]).toBe("0");
  });

  it.each([".or-input", ".or-tokens"])("draws %s with the control border on the page", (box) => {
    expect(declarationsFor(box)).toMatchObject({
      border: "1px solid var(--or-ctl)",
      background: "var(--or-page)",
    });
  });

  it("lifts the border on hover and draws the accent with the halo on focus", () => {
    expect(declarationsFor(".or-input:hover")["border-color"]).toBe("var(--or-sec)");
    expect(declarationsFor(".or-tokens:hover")["border-color"]).toBe("var(--or-sec)");
    for (const focus of [".or-input:focus", ".or-tokens:focus-within"]) {
      expect(declarationsFor(focus)).toMatchObject({
        "border-color": "var(--or-acc)",
        "box-shadow": "0 0 0 3px var(--or-halo)",
      });
    }
  });

  it("borders invalid controls in coral", () => {
    expect(declarationsFor('.or-input[aria-invalid="true"]')["border-color"]).toBe(
      "var(--or-fail)",
    );
    expect(declarationsFor(".or-tokens[data-invalid]")["border-color"]).toBe("var(--or-fail)");
    expect(declarationsFor(".or-field-error").color).toBe("var(--or-fail)");
  });

  it("sets mono fields in Geist Mono", () => {
    expect(declarationsFor(".or-input--mono")["font-family"]).toBe("var(--or-font-mono)");
    expect(declarationsFor(".or-tokens--mono")["font-family"]).toBe("var(--or-font-mono)");
  });

  it("draws the select without the native arrow", () => {
    expect(declarationsFor(".or-select__control").appearance).toBe("none");
  });
});
