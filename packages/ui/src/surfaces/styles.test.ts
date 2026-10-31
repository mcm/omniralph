import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const stylesDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../styles");
const css = readFileSync(path.join(stylesDir, "surfaces.css"), "utf8").replace(
  /\/\*[\s\S]*?\*\//g,
  "",
);
const topLevel = css.replace(/@media[^{]*\{(?:[^{}]*\{[^}]*\})*\s*\}/g, "");

function declarations(selector: string): Record<string, string> {
  const rule = Array.from(topLevel.matchAll(/([^{}]+)\{([^}]*)\}/g)).find(([, selectors]) =>
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

describe("surfaces.css", () => {
  it("is imported by styles.css", () => {
    expect(readFileSync(path.join(stylesDir, "index.css"), "utf8")).toMatch(
      /@import\s+"\.\/surfaces\.css"/,
    );
  });

  it("aligns the card actions to the right of the header", () => {
    expect(declarations(".or-card__head")).toMatchObject({
      display: "flex",
      "justify-content": "space-between",
    });
    expect(declarations(".or-card__actions")["margin-left"]).toBe("auto");
  });

  it("bolds the selected step", () => {
    expect(declarations(".or-step--selected .or-step__label")["font-weight"]).toBe("600");
    expect(declarations(".or-step__button").cursor).toBe("pointer");
  });

  it("numbers the steps", () => {
    expect(declarations(".or-steps")["counter-reset"]).toBe("or-step");
    expect(declarations(".or-step")["counter-increment"]).toBe("or-step");
    expect(declarations(".or-step::before").content).toBe("counter(or-step)");
  });

  it("rotates the details chevron when open and hides the native marker", () => {
    expect(declarations(".or-more-info[open] .or-more-info__chevron").transform).toBe(
      "rotate(90deg)",
    );
    expect(declarations(".or-more-info__summary")["list-style"]).toBe("none");
    expect(declarations(".or-more-info__summary::-webkit-details-marker").display).toBe("none");
  });

  it("shows the step chevrons, and hides the inline step panel, only at phone width", () => {
    expect(declarations(".or-step__open").display).toBe("none");
    const phone = css.match(/@media \(max-width: 768px\) \{((?:[^{}]*\{[^}]*\})*)\s*\}/)?.[1] ?? "";
    expect(phone).toMatch(/\.or-step__open\s*\{[^}]*display:\s*inline-flex/);
    expect(phone).toMatch(
      /\.or-progress-card--step-links \.or-step__panel\s*\{[^}]*display:\s*none/,
    );
    expect(declarations(".or-progress-card--step-links .or-step__panel").display).toBeUndefined();
  });

  it("keeps the save bar in view and gives nothing a glow", () => {
    expect(declarations(".or-savebar")).toMatchObject({ position: "sticky" });
    expect(css).not.toMatch(/box-shadow/);
  });

  it("opens the sheet from the right at 480 px", () => {
    expect(declarations(".or-sheet")).toMatchObject({
      position: "fixed",
      top: "0",
      right: "0",
      bottom: "0",
      width: "min(480px, 100vw)",
    });
    expect(declarations(".or-sheet").left).toBeUndefined();
  });

  it("makes the sheet full screen at 768 px and narrower", () => {
    const phone = css.match(/@media \(max-width: 768px\) \{((?:[^{}]*\{[^}]*\})*)\s*\}/)?.[1] ?? "";
    const sheet = phone.match(/(?:^|\})\s*\.or-sheet\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(sheet).toMatch(/left:\s*0/);
    expect(sheet).toMatch(/width:\s*100%/);
  });

  it("keeps the sheet above the shell's drawer and below menus and tooltips", () => {
    const z = (selector: string) => Number(declarations(selector)["z-index"]);
    expect(z(".or-sheet")).toBeGreaterThan(z(".or-sheet__scrim"));
    expect(z(".or-sheet__scrim")).toBeGreaterThan(41);
    expect(z(".or-sheet")).toBeLessThan(50);
  });
});
