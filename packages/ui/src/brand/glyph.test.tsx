import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { Glyph } from "./glyph.js";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../..");

/** The stylesheets that can style the glyph: the package's, the panel's and the agent page's. */
function stylesheets(): string[] {
  return ["packages/ui/styles", "apps/web/src", "apps/agent/ui/src"].flatMap((dir) =>
    readdirSync(path.join(REPO, dir), { recursive: true, encoding: "utf8" })
      .filter((file) => file.endsWith(".css"))
      .map((file) => path.join(dir, file)),
  );
}

/** Each CSS rule (`selector { declarations }`, nested ones too) whose selector names a glyph. */
function glyphRules(file: string): { selector: string; body: string }[] {
  const css = readFileSync(path.join(REPO, file), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  return [...css.matchAll(/([^{};]+)\{([^{}]*)\}/g)]
    .map((match) => ({ selector: match[1]!.trim(), body: match[2]! }))
    .filter(({ selector }) => /glyph/i.test(selector));
}

function svgOf(container: HTMLElement) {
  return container.querySelector("svg")!;
}

describe("Glyph", () => {
  it("renders 24 px in a 24-unit viewBox by default", () => {
    const { container } = render(<Glyph />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("24");
    expect(svg.getAttribute("height")).toBe("24");
    expect(svg.getAttribute("viewBox")).toBe("0 0 24 24");
  });

  it("strokes the ring with the text color and fills the cursor with the accent, without a tile", () => {
    const { container } = render(<Glyph />);
    const svg = svgOf(container);
    const circle = svg.querySelector("circle")!;
    expect(circle.getAttribute("stroke")).toBe("currentColor");
    expect(circle.getAttribute("cx")).toBe("9");
    expect(circle.getAttribute("cy")).toBe("11");
    expect(svg.querySelectorAll("rect")).toHaveLength(1);
    expect(svg.querySelector("rect")!.getAttribute("fill")).toBe("var(--or-acc)");
  });

  it("uses the small master at 32 px", () => {
    const { container } = render(<Glyph size={32} />);
    const svg = svgOf(container);
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(
      "translate(12 12) scale(0.92) translate(-12 -11)",
    );
    expect(svg.querySelector("circle")!.getAttribute("stroke-width")).toBe("2.8");
    const rect = svg.querySelector("rect")!;
    expect([rect.getAttribute("x"), rect.getAttribute("y")]).toEqual(["16", "14.2"]);
    expect([rect.getAttribute("width"), rect.getAttribute("height")]).toEqual(["5.5", "2.8"]);
    expect(rect.getAttribute("rx")).toBe("0.5");
  });

  it("uses the large master at 33 px", () => {
    const { container } = render(<Glyph size={33} />);
    const svg = svgOf(container);
    expect(svg.getAttribute("width")).toBe("33");
    expect(svg.querySelector("g")!.getAttribute("transform")).toBe(
      "translate(12 12) scale(0.8) translate(-12 -11)",
    );
    expect(svg.querySelector("circle")!.getAttribute("stroke-width")).toBe("2.6");
    const rect = svg.querySelector("rect")!;
    expect([rect.getAttribute("x"), rect.getAttribute("y")]).toEqual(["15", "14.9"]);
    expect([rect.getAttribute("width"), rect.getAttribute("height")]).toEqual(["6.5", "2.1"]);
    expect(rect.getAttribute("rx")).toBe("0.6");
  });

  it("is hidden from assistive tech without a label", () => {
    const { container } = render(<Glyph />);
    const svg = svgOf(container);
    expect(svg.getAttribute("aria-hidden")).toBe("true");
    expect(svg.getAttribute("role")).toBeNull();
    expect(screen.queryByRole("img")).toBeNull();
  });

  it("is an image named by its label", () => {
    render(<Glyph label="Omniralph" />);
    const img = screen.getByRole("img", { name: "Omniralph" });
    expect(img.getAttribute("aria-hidden")).toBeNull();
  });

  // Decided item 9 (`static-glyph`): the glyph is static, no animated or "live" logo.
  describe("is static", () => {
    it("takes no prop that animates it or makes it live", () => {
      // @ts-expect-error The glyph never animates (Decided: static-glyph).
      render(<Glyph animated />);
      // @ts-expect-error The glyph has no live state (Decided: static-glyph).
      render(<Glyph live />);
      // @ts-expect-error The glyph has no pulse (Decided: static-glyph).
      render(<Glyph pulse />);
      expect(document.querySelectorAll("svg[class='or-glyph']")).toHaveLength(3);
    });

    it("renders no animation element and no inline style", () => {
      const { container } = render(<Glyph size={48} label="Omniralph" />);
      const svg = svgOf(container);
      expect(svg.querySelector("animate, animateTransform, animateMotion, set, style")).toBeNull();
      expect(svg.querySelector("[style]")).toBeNull();
      expect(svg.getAttribute("style")).toBeNull();
    });

    it("has no animation, transition or keyframes in any stylesheet", () => {
      const files = stylesheets();
      expect(files).toContain("packages/ui/styles/brand.css");
      const animated = files.flatMap((file) =>
        glyphRules(file)
          .filter(({ body }) => /(^|[;\s])(animation|transition)[\w-]*\s*:/.test(body))
          .map(({ selector }) => `${file}: ${selector}`),
      );
      expect(animated).toEqual([]);
      const keyframes = files.filter((file) =>
        /@keyframes[^{]*glyph/i.test(readFileSync(path.join(REPO, file), "utf8")),
      );
      expect(keyframes).toEqual([]);
      expect(readFileSync(path.join(REPO, "packages/ui/styles/brand.css"), "utf8")).not.toMatch(
        /@keyframes|animation|transition/,
      );
    });

    it("finds the glyph's rules in the stylesheets", () => {
      expect(glyphRules("packages/ui/styles/brand.css").map(({ selector }) => selector)).toEqual([
        ".or-glyph",
        ".or-lockup .or-glyph",
      ]);
      expect(glyphRules("apps/web/src/screens/inbox/inbox.css").length).toBeGreaterThan(0);
    });
  });
});
