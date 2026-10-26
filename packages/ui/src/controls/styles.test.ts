import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "controls.css"), "utf8").replace(
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

/** The declarations every rule naming `selector` sets, later rules winning. */
const declarationsFor = (selector: string) =>
  Object.assign(
    {},
    ...rules.filter((rule) => rule.selectors.includes(selector)).map((rule) => rule.declarations),
  ) as Record<string, string>;

describe("controls.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/controls\.css"/,
    );
  });

  it.each([".or-switch", ".or-checkbox__input", ".or-radio", ".or-seg__option", ".or-tab"])(
    "%s shows the accent focus ring on :focus-visible",
    (control) => {
      expect(declarationsFor(`${control}:focus-visible`)).toEqual({
        outline: "2px solid var(--or-acc)",
        "outline-offset": "2px",
      });
    },
  );

  it("draws the switch with the control border when off and solid when on", () => {
    expect(declarationsFor(".or-switch").border).toBe("1px solid var(--or-ctl)");
    expect(declarationsFor('.or-switch[aria-checked="true"]')).toMatchObject({
      "border-color": "var(--or-solid)",
      background: "var(--or-solid)",
    });
  });

  it("draws the checkbox with a custom appearance", () => {
    expect(declarationsFor(".or-checkbox__input")).toMatchObject({
      appearance: "none",
      border: "1.5px solid var(--or-ctl)",
    });
    expect(declarationsFor(".or-checkbox__input:checked").background).toBe("var(--or-solid)");
    expect(declarationsFor(".or-checkbox__input:indeterminate").background).toBe("var(--or-solid)");
  });

  it("draws the radio round, solid when checked, with mono option labels on request", () => {
    expect(declarationsFor(".or-radio")).toMatchObject({
      border: "1.5px solid var(--or-ctl)",
      "border-radius": "50%",
    });
    expect(declarationsFor('.or-radio[data-state="checked"]').background).toBe("var(--or-solid)");
    expect(declarationsFor(".or-radio-list__options").display).toBe("flex");
    expect(declarationsFor(".or-radio-list__options")["flex-direction"]).toBe("column");
    expect(
      declarationsFor(".or-radio-list__options--mono .or-radio-list__option-label")["font-family"],
    ).toBe("var(--or-font-mono)");
  });

  it("marks the selected segment with --or-sel", () => {
    expect(declarationsFor('.or-seg__option[aria-checked="true"]').background).toBe(
      "var(--or-sel)",
    );
  });

  it("scrolls the tab strip horizontally instead of wrapping", () => {
    expect(declarationsFor(".or-tabs")).toMatchObject({
      "flex-wrap": "nowrap",
      "overflow-x": "auto",
    });
    expect(declarationsFor(".or-tab")["white-space"]).toBe("nowrap");
  });

  it("tones tab counts: tertiary by default, accent for need, coral for fail", () => {
    expect(declarationsFor(".or-tab__count").color).toBe("var(--or-ter)");
    expect(declarationsFor(".or-tab__count--need").color).toBe("var(--or-acc)");
    expect(declarationsFor(".or-tab__count--fail").color).toBe("var(--or-fail)");
  });

  it("draws the section index as the tab strip, scrolling instead of wrapping", () => {
    expect(declarationsFor(".or-tabs")).toMatchObject({
      "flex-wrap": "nowrap",
      "overflow-x": "auto",
    });
    expect(declarationsFor(".or-section-index__item").flex).toBe("none");
    expect(declarationsFor(".or-section-index__list")["list-style"]).toBe("none");
    expect(declarationsFor(".or-section-index .or-tab")["text-decoration"]).toBe("none");
  });

  it("marks the current section entry like the selected tab", () => {
    expect(declarationsFor('.or-tab[aria-current="true"]')).toEqual(
      declarationsFor('.or-tab[aria-selected="true"]'),
    );
    expect(declarationsFor('.or-tab[aria-current="true"]')["border-bottom-color"]).toBe(
      "var(--or-text)",
    );
  });
});
