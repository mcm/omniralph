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

  it("colors each progress segment by its step state", () => {
    const background = (state: string) => declarations(`.or-progress__seg--${state}`).background;
    expect(background("done")).toBe("var(--or-sec)");
    expect(background("waiting")).toBe("var(--or-acc)");
    expect(background("running")).toBe("var(--or-run)");
    expect(background("failed")).toBe("var(--or-fail)");
    expect(background("blocked")).toBe("var(--or-border)");
    expect(background("pending")).toBe("var(--or-border)");
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

  it("keeps the save bar in view and gives nothing a glow", () => {
    expect(declarations(".or-savebar")).toMatchObject({ position: "sticky" });
    expect(css).not.toMatch(/box-shadow/);
  });
});
